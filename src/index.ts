const resourceName =
  typeof GetCurrentResourceName === 'function' ? GetCurrentResourceName() : 'qbxsql';

console.log(`[${resourceName}] build loaded`);

