export function testStore() {
  const tables = new Map();
  const table = name => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const apply = ([ref, value, options]) => table(ref.collection).set(ref.id,
    options?.merge ? { ...table(ref.collection).get(ref.id), ...value } : value);
  let tail = Promise.resolve();
  return {
    table,
    collection(name) {
      const query = (conditions = [], maximum = Infinity) => ({
        doc(id) { return {
          collection: name, id,
          async get() {
            const data = table(name).get(id);
            return { exists: data != null, data: () => data };
          },
        }; },
        where(field, op, value) { return query([...conditions, [field, op, value]], maximum); },
        limit(count) { return query(conditions, count); },
        async get() { return { docs: [...table(name)].filter(([, row]) => conditions.every(([f, op, value]) =>
          op === '>=' ? row[f] >= value : op === '<=' ? row[f] <= value
            : op === 'array-contains' ? Array.isArray(row[f]) && row[f].includes(value)
              : row[f] === value))
          .slice(0, maximum).map(([id, value]) => ({ id, data: () => value })) }; },
      });
      return query();
    },
    batch() {
      const writes = [];
      return { set(...args) { writes.push(args); }, async commit() { writes.forEach(apply); } };
    },
    runTransaction(fn) {
      const execute = tail.then(async () => {
        const writes = [];
        const result = await fn({
          get: ref => ref.get(),
          set(...args) { writes.push(args); },
        });
        writes.forEach(apply);
        return result;
      });
      tail = execute.catch(() => undefined);
      return execute;
    },
  };
}
