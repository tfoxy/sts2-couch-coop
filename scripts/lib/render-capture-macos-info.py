"""Release provenance for a prebuilt macOS capture bundle."""
from pathlib import Path
import hashlib, json, sys
root = Path(sys.argv[1])
lines = (root / 'build-info.txt').read_text().splitlines()
fields = dict(line.split('=', 1) for line in lines if '=' in line)
print(json.dumps(dict(godotSceneWeb=sys.argv[2], xcode=lines[0], xcodeBuild=lines[1], sdk=lines[2],
    runnerImage=fields.get('runner_image'), runnerImageVersion=fields.get('runner_image_version'),
    buildInfo='\n'.join(lines), sha256={name: hashlib.sha256((root / name).read_bytes()).hexdigest()
        for name in ('librender_stream_capture.dylib', 'librender_stream_net.dylib')})))
