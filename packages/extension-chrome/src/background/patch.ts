// https://github.com/pmmmwh/react-refresh-webpack-plugin/issues/176#issuecomment-683150213
Object.assign(globalThis, {
  $RefreshReg$: () => {},
  $RefreshSig$: () => () => {},
});

export {};
