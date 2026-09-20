## Code style
- Don't write comments that restate what the code already says.
- Comment only the "why" when something isn't obvious: workarounds,
  counterintuitive decisions, constraints from an external API.
- No section-divider comments like `// --- Helpers ---`.
- Don't leave comments describing the change you just made.
## Production server: isolation rules
This checkout lives on the owner's **production** server. Production Dokploy
runs here as Swarm services (`dokploy`, `dokploy-postgres`, `dokploy-redis`)
plus the `dokploy-traefik` container, next to other production apps
(Authentik, NetBird, ...). Every test must run in isolation.

- Never run `pnpm dokploy:setup` / `apps/dokploy/setup.ts`: it initialises
  Swarm, networks, Traefik and Postgres on the host Docker.
- Never run `docker swarm ...` or `docker service ...`, and never
  restart/stop/rm a container, network or volume that is not labelled
  `com.abhash.sandbox`.
- Never point `DATABASE_URL`, Redis or Traefik paths at production, and never
  use the production Authentik for tests.
- Run the app, migrations and integration/e2e tests only through
  `scripts/sandbox/sandbox.sh`. It starts labelled throwaway Postgres, Redis
  and Docker-in-Docker (plus optional mock OIDC, Authentik and Traefik) bound
  to 127.0.0.1 on free ports, and points `DOCKER_HOST` at the sandbox daemon
  so the app can never drive the host Docker.
- Tear down with `sandbox.sh down`; it removes only labelled resources.
- Read-only inspection of production (`docker ps`, read-only `SELECT`s) is
  fine; ask before anything that writes.

## Workflow
- `main` is production: merging publishes a GHCR image and release. Work on
  short-lived branches (`feat/`, `fix/`, `chore/`, `perf/`) and PR into `main`.
- Upstream syncs merge `upstream/canary`; see FORK.md for conflict patterns.
- Fork-only code lives in `abhash` paths; never copy from `/proprietary`.
- Fork migrations are numbered after upstream's and must be idempotent.
- No `Co-Authored-By: Claude` trailers on commits.
