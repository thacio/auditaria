# Copyright 2026 Thacio
# SPDX-License-Identifier: Apache-2.0
"""Bounded media preparation, independent of the embedding model and database."""

import json
import math
from pathlib import Path
import subprocess
from contextlib import contextmanager, closing

IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif', '.webp'}
AUDIO_EXTENSIONS = {'.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac'}
VIDEO_EXTENSIONS = {'.mp4', '.webm', '.mov', '.mkv', '.avi'}
AUDIO_SECONDS = 30
VIDEO_SECONDS = 10


def run_media_command(args):
    try:
        return subprocess.run(args, check=True, capture_output=True, timeout=60,
                              creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout
    except FileNotFoundError as error:
        raise RuntimeError('Audio/video indexing requires ffmpeg and ffprobe on PATH') from error
    except subprocess.CalledProcessError as error:
        raise RuntimeError(error.stderr.decode('utf-8', errors='replace')[-2000:]) from error


def chunk(source, index, text, page=None, section=None):
    metadata = {}
    if page is not None:
        metadata['page'] = page
    if section is not None:
        metadata['section'] = section
    return {'index': index, 'text': text, 'startOffset': 0, 'endOffset': len(text),
            'metadata': metadata, 'source': source}


def prepare_media(filename):
    path = Path(filename).resolve(strict=True)
    suffix = path.suffix.lower()
    source = {'path': str(path)}
    if suffix in IMAGE_EXTENSIONS:
        return {'chunks': [chunk({**source, 'kind': 'image'}, 0,
                                 f'[Image: {path.name}]', section='Image')]}
    if suffix == '.pdf':
        import pypdfium2 as pdfium
        chunks = []
        with pdfium.PdfDocument(path) as pdf:
            for index in range(len(pdf)):
                with closing(pdf[index]) as page:
                    with closing(page.get_textpage()) as textpage:
                        text = textpage.get_text_range().strip()
                # Preserve embedded text for keyword search; scanned pages need no OCR.
                chunks.append(chunk({**source, 'kind': 'pdf', 'page': index + 1}, index,
                                    text or f'[Visual PDF page {index + 1}: {path.name}]',
                                    page=index + 1, section='Visual PDF page'))
            return {'chunks': chunks, 'pageCount': len(pdf)}
    if suffix not in AUDIO_EXTENSIONS | VIDEO_EXTENSIONS:
        raise ValueError(f'Unsupported media file: {suffix}')
    info = json.loads(run_media_command([
        'ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(path)]))
    duration = float(info.get('format', {}).get('duration', 0))
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('Media duration is missing or invalid')
    kinds = ['audio'] if suffix in AUDIO_EXTENSIONS else ['video']
    if kinds == ['video'] and any(s['codec_type'] == 'audio' for s in info['streams']):
        kinds.append('audio')  # Index speech/sounds separately from visual frames.
    chunks = []
    for kind in kinds:
        seconds = AUDIO_SECONDS if kind == 'audio' else VIDEO_SECONDS
        for start in range(0, math.ceil(duration), seconds):
            end = min(start + seconds, duration)
            label = f'{kind.capitalize()} {start:.2f}s–{end:.2f}s'
            chunks.append(chunk({**source, 'kind': kind, 'start': start, 'end': end},
                                len(chunks), f'[{label}: {path.name}]', section=label))
    return {'chunks': chunks}


@contextmanager
def decode_media(source):
    """Decode one page/segment at a time; never retain entire videos or PDFs."""
    import numpy as np
    from PIL import Image
    path = Path(source['path']).resolve(strict=True)
    kind = source['kind']
    if kind == 'image':
        with Image.open(path) as original:
            image = original.convert('RGB')
        try:
            yield {'image': image}
        finally:
            image.close()
    elif kind == 'pdf':
        import pypdfium2 as pdfium
        with pdfium.PdfDocument(path) as pdf:
            page_number = source['page']
            if not isinstance(page_number, int) or not 1 <= page_number <= len(pdf):
                raise ValueError('PDF page is out of range')
            with closing(pdf[page_number - 1]) as page:
                # Bound raster memory even for unusually large PDF page dimensions.
                scale = min(2.0, 1600 / max(page.get_size()))
                bitmap = page.render(scale=scale)
                image = bitmap.to_pil().convert('RGB')
                try:
                    yield {'image': image}
                finally:
                    image.close()
                    bitmap.close()
    elif kind in ('audio', 'video'):
        start, end = float(source['start']), float(source['end'])
        maximum = AUDIO_SECONDS if kind == 'audio' else VIDEO_SECONDS
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end
                and end - start <= maximum):
            raise ValueError('Invalid or oversized media segment')
        args = ['ffmpeg', '-nostdin', '-v', 'error', '-ss', str(start), '-i', str(path),
                '-t', str(end - start)]
        if kind == 'audio':
            data = run_media_command(args + ['-vn', '-ac', '1', '-ar', '16000',
                                            '-f', 'f32le', 'pipe:1'])
            audio = np.frombuffer(data, dtype='<f4').copy()
            if audio.size == 0:
                raise ValueError('Decoded audio is empty')
            yield {'audio': {'array': audio, 'sampling_rate': 16000}}
        else:
            # One frame/second, bounded resolution, preserving aspect ratio with padding.
            data = run_media_command(args + ['-an', '-vf',
                'fps=1,scale=384:384:force_original_aspect_ratio=decrease,pad=384:384:(ow-iw)/2:(oh-ih)/2',
                '-frames:v', str(VIDEO_SECONDS), '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
            if not data:
                raise ValueError('Decoded video is empty')
            frames = np.frombuffer(data, dtype=np.uint8).reshape(-1, 384, 384, 3).copy()
            yield {'video': {'array': frames, 'video_metadata': {
                'fps': 1, 'total_num_frames': len(frames),
                'duration': float(len(frames)), 'frames_indices': list(range(len(frames)))}}}
    else:
        raise ValueError(f'Unsupported media kind: {kind}')
