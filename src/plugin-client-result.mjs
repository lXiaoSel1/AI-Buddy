/** Recreate an Error in the receiving renderer, after the plain IPC envelope crossed worlds. */
export function pluginClientResult(value) {
  const error = value?.__buddyError ? value : value?.ok === false ? value.error : null;
  if (error) throw Object.assign(Error(error.message ?? 'Work client request failed'), {code: error.code, details: error.details});
  return value?.ok === true && Object.hasOwn(value, 'result') ? value.result : value;
}
