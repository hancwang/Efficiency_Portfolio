# Confluence Next Step sync service

This internal service accepts an authenticated dashboard update and changes only the matching Jira row's **Next Step** cell on Confluence page `860877904`.

Required environment variables:

- `CONFLUENCE_BASE_URL=https://confluence-eng-gpk2.cisco.com/conf`
- `CONFLUENCE_TOKEN=<server-side service token>`
- `ALLOWED_ORIGINS=https://hancwang.github.io`
- `TRUSTED_IDENTITY_HEADER=x-authenticated-user`
- `PORT=8787` (optional)

Deploy behind a Cisco-authenticated reverse proxy that supplies the trusted identity header. Never expose the Confluence token to the browser or commit it to GitHub.

The dashboard's sync endpoint is configured in the browser once with:

```js
localStorage.setItem("efficiencySyncApiUrl", "https://<internal-service>/api/sync-next-step")
```

The service permits only the configured dashboard origin and updates only the Next Step cell for a valid `WBXPLTFM-*` key.
