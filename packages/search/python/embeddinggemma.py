# Copyright 2026 Thacio
# SPDX-License-Identifier: Apache-2.0
"""EmbeddingGemma 2 inference worker. Stdout is reserved for JSONL responses."""

import contextlib
import json
import sys

from media_inputs import decode_media, prepare_media


class GemmaEngine:
    def __init__(self, config):
        import torch
        from sentence_transformers import SentenceTransformer
        if config.get('model') != 'google/embeddinggemma-2':
            raise ValueError('This worker supports google/embeddinggemma-2 only')
        device = config.get('device', 'auto')
        if device == 'auto':
            device = 'cuda' if torch.cuda.is_available() else 'cpu'
        if device not in ('cuda', 'cpu'):
            raise ValueError('EmbeddingGemma supports cpu, cuda, or auto')
        self.device = device
        self.multimodal = config.get('multimodal', True)
        self.batch_size = max(1, min(32, int(config.get('batch_size', 8))))
        self.model = SentenceTransformer(
            config['model'], device=device, cache_folder=config.get('cache_dir'),
            # FP16 is unsafe for this model. FP32 also keeps CPU/GPU indexes compatible.
            model_kwargs={'torch_dtype': torch.float32},
            config_kwargs={} if self.multimodal else {'vision_config': None, 'audio_config': None})

    def encode(self, inputs, **kwargs):
        import numpy as np
        if len(inputs) == 0:
            return []
        vectors = self.model.encode(inputs, batch_size=self.batch_size,
                                    normalize_embeddings=True, show_progress_bar=False, **kwargs)
        if vectors.shape != (len(inputs), 768) or not np.isfinite(vectors).all():
            raise ValueError('Invalid EmbeddingGemma output shape or non-finite values')
        norms = np.linalg.norm(vectors, axis=1)
        if not np.allclose(norms, 1, atol=1e-4):
            raise ValueError('EmbeddingGemma returned zero or unnormalized vectors')
        return vectors.tolist()

    def handle(self, request):
        method = request['method']
        if method == 'embed':
            purpose = request.get('purpose', 'raw')
            prompt = {'query': 'SearchQuery', 'document': 'Document', 'raw': None}[purpose]
            return self.encode(request['texts'], prompt_name=prompt)
        if not self.multimodal:
            raise ValueError('Multimodal embedding is disabled')
        if method == 'prepare_media':
            return prepare_media(request['path'])
        if method == 'embed_media':
            vectors = []
            for source in request['sources']:
                with decode_media(source) as media:
                    # Media is embedded directly: labels/filenames are never semantic input.
                    vectors.extend(self.encode([media]))
            return vectors
        raise ValueError(f'Unknown method: {method}')


def main():
    engine = None
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            # Libraries may print while loading/encoding. Keep the protocol unambiguous.
            with contextlib.redirect_stdout(sys.stderr):
                if request['method'] == 'init':
                    engine = GemmaEngine(request)
                    result = {'dimensions': 768, 'device': engine.device}
                elif engine is None:
                    raise RuntimeError('EmbeddingGemma is not initialized')
                else:
                    result = engine.handle(request)
            response = {'id': request['id'], 'result': result}
        except Exception as error:
            response = {'id': request.get('id'), 'error': str(error)}
        print(json.dumps(response, allow_nan=False), flush=True)


if __name__ == '__main__':
    main()
