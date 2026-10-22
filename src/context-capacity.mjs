// Application budget used only when the selected connection has no declared
// capacity. This is a user-selected default, not a verified model limit.
export const DEFAULT_CONTEXT_TOKENS = 272000;
export const defaultContextCapacity = () => ({tokens:DEFAULT_CONTEXT_TOKENS,source:'application-default',verified:false});
