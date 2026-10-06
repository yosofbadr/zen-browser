# Personal Zen builds

This fork keeps Zen's upstream history. `dev` tracks upstream, `main` contains the personal build setup and both features, and contribution branches contain one change each.

- `feature/youtube-site-search` adds YouTube search suggestions.
- `fix/sidebar-animation` fixes compact-mode sidebar movement.

## Develop and test

Create a branch from `main` for personal development, then run:

```sh
./personal/nightly
```

Nightly uses a separate copy of your profile with Firefox Sync disabled. Quit Nightly before replacing its app. Existing native build caches are reused. To refresh its profile from the daily profile, close both personal browsers and run `./personal/nightly --refresh-profile`.

For upstream contributions, branch from `upstream/dev`. Keep personal build tooling off those branches. Merge the contribution into a personal testing branch to test it with Nightly.

## Ship an update

```sh
git switch main
git merge your-feature-branch
git push origin main
```

The local LaunchAgent checks `origin/main` every minute while your Mac is awake. It builds, tests and signs a candidate, then installs it after you quit Zen Personal. Failed builds leave the installed app in place. Profiles stay in `~/Library/Application Support/Zen Personal`. Official Zen remains separate.

Run `./personal/setup` to install or refresh the service. The configuration and signing stay local. No browser profile or credential is stored in this repository.

## Update from upstream

```sh
git switch main
git switch -c update/upstream
./personal/update-upstream dev
./personal/nightly
```

Resolve any merge conflicts and test before merging the branch into `main` and pushing. This is a normal Git merge, preserving upstream history. It does not automatically ship untested upstream changes.

## Check the service

```sh
python3 personal/zen.py status
tail -f "$HOME/Library/Logs/Zen Personal/build.log"
```

The older `zen-personal` checkout is retained because the existing managed build worktrees still use its Git storage. The builder fetches fork commits into those worktrees to preserve their caches. Develop in this fork; do not delete the older checkout until those worktrees are migrated.
