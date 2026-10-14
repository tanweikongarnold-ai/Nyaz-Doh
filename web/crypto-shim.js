// The bits of node:crypto that server/rooms.js uses, built on the browser's Web Crypto.
const webCrypto = globalThis.crypto;
const bytes = (n) => webCrypto.getRandomValues(new Uint8Array(n));

export default {
  randomUUID: () => (webCrypto.randomUUID ? webCrypto.randomUUID() : [...bytes(16)].map((b) => b.toString(16).padStart(2, '0')).join('')),
  randomBytes: (n) => {
    const b = bytes(n);
    return { toString: () => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
  },
  randomInt: (min, max) => {
    if (max === undefined) [min, max] = [0, min];
    return min + Math.floor(Math.random() * (max - min));
  },
};
