# Local trial environment: Azurite blob emulator as the fleet bucket.
export AZURE_STORAGE_USE_EMULATOR=true
export AZURE_STORAGE_ACCOUNT_NAME=devstoreaccount1
export AZURE_STORAGE_ACCOUNT_KEY='Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='
export CELLD_BUCKET="${CELLD_BUCKET:-az://celld}"
export CELLD="${CELLD:-$HOME/projects/celld/target/release/celld}"
# The mock LLM (celld/mock-llm.ts, port MOCK_LLM_PORT) is a private address; once celld refuses
# private fetch targets (plan item 1.9), the node needs this to reach it. Name exactly the
# host:port entries needed.
export CELLD_FETCH_PRIVATE_ALLOW="${CELLD_FETCH_PRIVATE_ALLOW:-127.0.0.1:${MOCK_LLM_PORT:-11434}}"
export CELLD_ESBUILD="${CELLD_ESBUILD:-$(ls -d "$(dirname "${BASH_SOURCE[0]}")"/../node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | tail -1)}"

# Local trial account, created on the trial deployment through the sign-up page.
export CFOS_TRIAL_USER=admin
export CFOS_TRIAL_PASSWORD=598d9704eac03476b353cf79
