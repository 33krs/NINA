function observedWaiters(rows, identities, table) {
  if (!['Prescription', 'Batch'].includes(table)) return false;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  if (byPid.size !== rows.length || rows.length !== 3) return false;
  if (new Set(identities.map(({ pid }) => pid)).size !== 3) return false;
  if (
    identities.some(({ pid, started }) => byPid.get(pid)?.started !== started)
  )
    return false;
  const [blocker, ...writers] = identities;
  function reachesBlocker(pid, visited) {
    if (pid === blocker.pid) return true;
    if (visited.has(pid) || !writers.some((writer) => writer.pid === pid))
      return false;
    const blockers = byPid.get(pid)?.blockers;
    return (
      Array.isArray(blockers) &&
      blockers.length > 0 &&
      blockers.every((parent) =>
        reachesBlocker(parent, new Set([...visited, pid])),
      )
    );
  }
  return writers.every(({ pid }) => {
    const row = byPid.get(pid);
    return (
      row.state === 'active' &&
      row.wait === 'Lock' &&
      typeof row.query === 'string' &&
      row.query.includes(`FROM "${table}"`) &&
      /\bFOR UPDATE\b/.test(row.query) &&
      reachesBlocker(pid, new Set())
    );
  });
}

module.exports = { observedWaiters };
