# Contributing

Thanks for helping. Speck OS is licensed under the [AGPL-3.0](LICENSE), and contributions are accepted under the same license.

## Sign your commits

Every commit needs a `Signed-off-by` line, which certifies the [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change, or otherwise have the right to submit it under this project's license.

```sh
git commit -s
```

## Before you open a pull request

- Run the tests for what you changed (see "Tests" in the [README](README.md)): `node --test broker/test/*.test.mjs`, `node --test voice/test/service.test.mjs`, `node --test nli/test/service.test.mjs`.
- Changes to the image or installer: run `bash image/build.sh --test` (or `--boot-test` for the Secure Boot boot) and include the result.
- Keep anything that can't be redistributed out of the image: Google Chrome, models with restrictive licenses, and other proprietary software. Add new bundled components to [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Security

Speck OS runs an agent with root access. Please report vulnerabilities privately through GitHub's security advisories rather than in a public issue.
