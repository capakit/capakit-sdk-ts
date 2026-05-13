# Development Workflow

## Dev Release

```sh
npm run dev-release
```

This runs checks, creates a tag like `dev/v0.0.4-dev.20260513120000.abcdef12`, pushes `dev`, and pushes the tag.
The tag triggers `.github/workflows/publish.yml`, which publishes `@capakit/sdk` with the npm `dev` dist-tag.

## Production Release

```sh
npm run release
```

This fetches `origin/main`, `origin/dev`, and tags, promotes the latest dev release tag to `main` with a fast-forward
merge, bumps the production version, commits, creates `vX.Y.Z`, and pushes `main` plus the production tag. The
production tag triggers npm publish with the default `latest` dist-tag.

Use `npm run release -- mid` or `npm run release -- large` for minor or major bumps. Use
`npm run release -- --dev-tag dev/v...` to promote a specific dev tag.
