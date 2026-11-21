#!/bin/sh
# Rebuild the downloadable extension zip and the file list used by "Update extension" in CA Desk.
set -e
cd "$(dirname "$0")/.."
rm -f ca-desk-helper.zip
(cd extension && zip -qr ../ca-desk-helper.zip .)
python3 - <<'PY'
import json, os
v = json.load(open('extension/manifest.json'))['version']
files = sorted(f for f in os.listdir('extension') if os.path.isfile(os.path.join('extension', f)))
json.dump({'version': v, 'files': files}, open('ext-files.json', 'w'))
print('extension', v, files)
PY
# DSC reader installer template (CA Desk fills in this computer's extension id when you download it)
python3 - <<'PY'
t = open('dsc-helper/install.cmd.tpl').read().replace('__HOSTPS__', open('dsc-helper/host.ps1').read().rstrip('\n'))
open('dsc-reader-install.tpl', 'w').write(t)
PY
