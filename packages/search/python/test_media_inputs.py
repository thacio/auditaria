# Copyright 2026 Thacio
# SPDX-License-Identifier: Apache-2.0

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from media_inputs import prepare_media, decode_media


class MediaInputsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def file(self, name):
        path = self.root / name
        path.touch()
        return str(path)

    @patch('media_inputs.run_media_command')
    def test_video_indexes_visual_and_audio_tracks_with_bounded_segments(self, command):
        command.return_value = json.dumps({'format': {'duration': '65.5'},
                                           'streams': [{'codec_type': 'video'}, {'codec_type': 'audio'}]}).encode()
        document = prepare_media(self.file('meeting.mp4'))
        sources = [chunk['source'] for chunk in document['chunks']]
        visual = [source for source in sources if source['kind'] == 'video']
        audio = [source for source in sources if source['kind'] == 'audio']
        self.assertEqual(len(visual), 7)
        self.assertEqual(len(audio), 3)
        self.assertEqual(visual[-1]['end'], 65.5)
        self.assertEqual(audio[-1]['end'], 65.5)
        self.assertTrue(all(s['end'] - s['start'] <= 10 for s in visual))
        self.assertTrue(all(s['end'] - s['start'] <= 30 for s in audio))

    @patch('media_inputs.run_media_command')
    def test_invalid_duration_is_not_silently_indexed(self, command):
        command.return_value = b'{"format":{"duration":"NaN"},"streams":[]}'
        with self.assertRaisesRegex(ValueError, 'duration'):
            prepare_media(self.file('audio.wav'))

    def test_pdf_pages_keep_references_without_ocr(self):
        from PIL import Image
        path = self.root / 'scan.pdf'
        with Image.new('RGB', (100, 100), 'white') as image:
            image.save(path, 'PDF')
        document = prepare_media(str(path))
        self.assertEqual(document['pageCount'], 1)
        self.assertEqual(document['chunks'][0]['metadata']['page'], 1)
        self.assertIn('Visual PDF page 1', document['chunks'][0]['text'])
        with decode_media(document['chunks'][0]['source']) as decoded:
            self.assertEqual(decoded['image'].mode, 'RGB')

    def test_oversized_audio_is_rejected_before_decoding(self):
        source = {'kind': 'audio', 'path': self.file('audio.wav'), 'start': 0, 'end': 31}
        with self.assertRaisesRegex(ValueError, 'oversized'):
            with decode_media(source):
                pass


if __name__ == '__main__':
    unittest.main()
