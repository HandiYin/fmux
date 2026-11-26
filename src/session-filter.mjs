// Simple session-name globs: * matches any text, ? matches one character.
export function sessionFilter({ include = [], exclude = [], hide = [] } = {}) {
  const compile = (patterns) => {
    if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string' || !p)) throw new Error('tmux filters must be arrays of nonempty name patterns');
    return patterns.map((p) => new RegExp('^' + [...p].map((c) => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$'));
  };
  const included = compile(include);
  const excluded = compile(exclude);
  return (name) => !hide.includes(name) && (!included.length || included.some((p) => p.test(name))) && !excluded.some((p) => p.test(name));
}
