# Open Dots MCP marketplace

The marketplace has two sections: **Tested by Open Dots** and **Community**. Every merged community manifest is listed in Community. A listing appears in Tested by Open Dots only after an Open Dots maintainer records product test evidence in the `tested` catalog.

## Submit a community listing

Add one JSON file at `marketplace/plugins/community/<slug>.json` using the schema at `marketplace/schema/plugin.schema.json`. The filename must match its stable `slug`. Listings require a public HTTPS Streamable HTTP MCP endpoint, publisher and source repository, `none` or `bearer_token` authentication, privacy and terms URLs, a license, and setup and test instructions.

Do not include commands, stdio transports, scripts, binaries, credentials, tokens, or private/local-network URLs. Never place secrets in a listing. A community manifest cannot set or claim tested status. Maintainers add a separate evidence record only after exercising the listed version.

After adding a manifest, run `python3 scripts/update-marketplace-index.py` and include the updated `marketplace/catalog.json` in the same PR. The normal GitHub pull request checks validate the schema, changed manifests, catalog index, and examples. Maintainers review and merge the PR through the standard GitHub process. **After merge, the entry appears in Community; there is no second publisher queue.**

Only unauthenticated access and user-entered bearer tokens are supported by this catalog format. OAuth and stdio servers are not supported. Connecting an entry does not grant it to an agent. Owners separately choose exact tools for each agent; every call requires its own approval.

## Tested listings

Tested entries use the same manifest fields under `marketplace/plugins/tested/` and add an `evidence` object containing the tested version, date, and an Open Dots evidence URL. Only maintainers may add or change these files. A community listing can also appear in Tested by Open Dots after it has been exercised; the Community listing remains available, and the two labels describe different facts. Copies in both sections must use the same manifest content.
