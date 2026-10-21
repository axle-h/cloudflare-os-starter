# Cloudflare OS on celld (trial)

Runs this deployment on a local [celld](https://github.com/denoland/celld) node instead of
Cloudflare. It is a trial harness, not a supported deploy path: the findings live in celld's
`plans/cloudflare-os-trial.md`.

1. Start a bucket. celld needs S3, GCS or Azure; locally, the Azurite emulator works:

   ```sh
   podman run -d --name celld-azurite -p 10000:10000 \
     mcr.microsoft.com/azure-storage/azurite azurite-blob --blobHost 0.0.0.0 --loose
   python3 celld/azurite-container.py celld
   ```

2. Build the Workers: `celld/build.sh`.
3. Deploy: `celld/deploy.sh --no-router`. Without `--no-router` the router is the entry point, but
   celld cannot yet return a WebSocket through a service binding, so the `/api` session fails.
4. Run a node:

   ```sh
   . celld/env.sh && mkdir -p .celld && cd .celld && \
     "$CELLD" --bucket "$CELLD_BUCKET" --listen 127.0.0.1:8790 > node.log 2>&1 &
   ```

5. Open http://127.0.0.1:8790 and sign up as `admin` (the configured admin; the trial password
   is in `celld/env.sh`).

`env.sh` expects the celld binary at `~/projects/celld/target/release/celld`; set `CELLD` to
override it. `generate.ts` documents each workaround it applies to the configs.
