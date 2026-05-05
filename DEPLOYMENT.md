# Deployment

This MCP server is deployed to the Pathfinder DO droplet as a Docker container.

## Quick Reference

| Field | Value |
|---|---|
| Droplet | `mcp-server` (SSH alias) |
| Service name | `trello` |
| URL | `https://trello.mcp.pathfindermarketing.com.au/mcp` |
| Docker image | `ghcr.io/pmlabs-org/mcp-trello:latest` |
| Env file | `/opt/pmin-mcpinfrastructure/env/trello.env` |
| Full docs | [PM-Labs/pmin-mcpinfrastructure](https://github.com/PM-Labs/pmin-mcpinfrastructure) -> `docs/runbooks/trello.md` |

## Deploy

```bash
# Deployments are automated via CI — push to main triggers build + deploy.
# Manual deploy (if needed):
ssh mcp-server "cd /opt/pmin-mcpinfrastructure && docker compose pull trello && docker compose up -d --force-recreate trello"
```

## Rollback

```bash
ssh mcp-server "cd /opt/pmin-mcpinfrastructure && docker compose stop trello"
# Revert to previous image tag, then: docker compose up -d trello
```

## Operational Docs

See [PM-Labs/pmin-mcpinfrastructure](https://github.com/PM-Labs/pmin-mcpinfrastructure) for:
- Architecture: `docs/ARCHITECTURE.md`
- Runbook: `docs/runbooks/trello.md`
- Cron jobs: `docs/CRON-JOBS.md`
