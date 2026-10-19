// Minimal line diff for showing configuration changes before they are applied.

export function lineDiff(before        , after        , context = 3)         {
  const a = before === '' ? [] : before.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

  // Trim the common prefix and suffix so the LCS table stays small for typical edits.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);


  const ops       = [];
  for (let i = 0; i < start; i++) ops.push({ t: ' ', s: a[i]           });

  if (midA.length * midB.length > 4_000_000) {
    for (const s of midA) ops.push({ t: '-', s });
    for (const s of midB) ops.push({ t: '+', s });
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs             = Array.from({ length: n + 1 }, () => new Array        (m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      const row = lcs[i]            ;
      const below = lcs[i + 1]            ;
      for (let j = m - 1; j >= 0; j--) {
        row[j] = midA[i] === midB[j] ? (below[j + 1]          ) + 1 : Math.max(below[j]          , row[j + 1]          );
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ t: ' ', s: midA[i]           });
        i++;
        j++;
      } else if (((lcs[i + 1]            )[j]          ) >= ((lcs[i]            )[j + 1]          )) {
        ops.push({ t: '-', s: midA[i]           });
        i++;
      } else {
        ops.push({ t: '+', s: midB[j]           });
        j++;
      }
    }
    while (i < n) ops.push({ t: '-', s: midA[i++]           });
    while (j < m) ops.push({ t: '+', s: midB[j++]           });
  }
  for (let i = endA; i < a.length; i++) ops.push({ t: ' ', s: a[i]           });

  // Keep only changed lines plus context.
  const keep = new Array         (ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.t === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });
  const out           = [];
  let skipped = false;
  ops.forEach((op, idx) => {
    if (!keep[idx]) {
      skipped = true;
      return;
    }
    if (skipped && out.length > 0) out.push('  …');
    skipped = false;
    out.push(`${op.t} ${op.s}`);
  });
  return out.join('\n');
}
