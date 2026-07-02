# Files NOT uploaded to Vercel on deploy. Keeps the deploy under the upload
# size limit: genesis/finalize zkeys and the ptau are large and the deployed
# app never reads them from the filesystem (it serves zkeys from Blob and
# fetches the ptau from its Blob URL).

node_modules
.next
.vercel
.git

# Secrets / local-only
.env
.env.*
*.tsbuildinfo

# Operator-local artifacts the deployed app does not serve. The leading slash
# anchors each to the project root. An unanchored "circuits" would also match
# the API route directory src/app/api/ceremony/circuits and 404 every
# /circuits/[id]/* endpoint — anchor to /circuits to exclude only the data dir.
# - /backups: reset-ceremony snapshots (large)
# - /public/genesis, /public/finalize: zkeys served from Blob, not from public/
# - /circuits: r1cs + downloaded ptau, used only by local init/finalize scripts
/backups
/public/genesis
/public/finalize
/circuits
