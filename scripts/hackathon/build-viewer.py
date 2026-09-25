from pathlib import Path
import json

root = Path(__file__).resolve().parents[2]
report = json.loads((root / 'docs/hackathon/demo-results.json').read_text())
chain = json.loads((root / 'docs/hackathon/local-chain-results.json').read_text())
assert chain['status'] == 'PASS'
html = (root / 'scripts/hackathon/viewer.html').read_text()
for marker, data in [('__REPORT__', report), ('__CHAIN__', chain)]:
    html = html.replace(marker, json.dumps(data).replace('<', '\\u003c'))
(root / 'docs/hackathon/index.html').write_text(html)
print('Generated standalone evidence viewer')
