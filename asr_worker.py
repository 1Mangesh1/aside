# On-device speech to text for aside: NVIDIA Parakeet through parakeet-mlx.
# Loads the model once, then reads one JSON request per stdin line ({"id", "path", "sentences"}) and writes one JSON
# reply per stdout line ({"id", "text", "sentences"?} or {"id", "error"}). Started by lib/asr.mjs with:
#   uv run --python 3.12 --with parakeet-mlx==0.5.3 python asr_worker.py
import json
import sys

from parakeet_mlx import from_pretrained

model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")
print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    req = json.loads(line)
    try:
        # Chunking keeps memory flat on long meetings; the values follow the parakeet-mlx README example.
        result = model.transcribe(req["path"], chunk_duration=120.0, overlap_duration=15.0)
        reply = {"id": req["id"], "text": result.text.strip()}
        if req.get("sentences"):
            reply["sentences"] = [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in result.sentences]
        print(json.dumps(reply), flush=True)
    except Exception as e:  # one bad recording must not stop the worker
        print(json.dumps({"id": req["id"], "error": str(e)}), flush=True)
