const mtn = require('mtn-apm-agent/mtn');

// get all methods on the prototype
const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(mtn)).filter(
  name => typeof mtn[name] === 'function'
);

console.log(methods);

// get all getters
const getters = Object.getOwnPropertyNames(Object.getPrototypeOf(mtn))
  .filter(name => {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(mtn), name);
    return desc && typeof desc.get === 'function';
  });

console.log('Getters:', getters);
