// Parsing `docker run` argument lists from registry entries and configured servers.
// Registry entries may only use `run` with a small allowlist of flags before the image;
// everything after the image belongs to the server and is not interpreted as docker flags.

export const CONTAINER_CLIS = /^(docker|podman|podman-remote|nerdctl|finch|lima|colima)$/;

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set([
  '-i', '-t', '-d', '--interactive', '--tty', '--detach', '--rm', '--init', '-q', '--quiet', '--read-only', '--no-healthcheck',
]);

/** Flags followed by a value (as the next argument or after "="). */
const VALUE_FLAGS = new Set([
  '-e', '--env', '--name', '-p', '--publish', '-w', '--workdir', '-u', '--user', '--entrypoint', '-l', '--label',
  '--platform', '--pull', '-m', '--memory', '--cpus', '--add-host', '--dns', '--hostname', '--restart', '--stop-timeout',
  '--log-driver', '--health-cmd', '--health-interval',
]);








/** Validate `run <flags> <image> [server args...]` against the allowlist. */
export function parseRunArgs(args                   )          {
  if (args[0] !== 'run') return { ok: false, error: 'only `run` is allowed for container commands', imageIndex: -1 };
  for (let i = 1; i < args.length; i++) {
    const a = args[i]          ;
    if (!a.startsWith('-')) return { ok: true, imageIndex: i };
    if (BOOLEAN_FLAGS.has(a)) continue;
    // Combined short boolean flags such as -it or -itd.
    if (/^-[itdq]{2,4}$/.test(a)) continue;
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.has(name)) {
      if (eq < 0) i++; // the value is the next argument
      continue;
    }
    return { ok: false, error: `container flag ${a} is not allowed`, imageIndex: -1 };
  }
  return { ok: false, error: 'no image name after the flags', imageIndex: -1 };
}

/** Index of the image in a configured server's args (lenient: unknown flags are skipped). */
export function imageIndex(args                   )         {
  if (args[0] !== 'run') return -1;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]          ;
    if (!a.startsWith('-')) return i;
    if (!a.includes('=') && VALUE_FLAGS.has(a)) i++;
  }
  return -1;
}
