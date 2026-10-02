// Base URL of the deployed leaderboard Worker (see leaderboard/README.md), without
// a trailing slash, e.g. "https://clawd-merge-leaderboard.<you>.workers.dev".
// Leave empty to play without a leaderboard.
// Only on a loopback page (localhost, 127.0.0.1, [::1]), a loopback HTTP(S)
// origin such as `?api=http://localhost:8787` can override it. Production ignores it.
export const LEADERBOARD_API = 'https://clawd-merge-leaderboard.tt-lab.workers.dev';
