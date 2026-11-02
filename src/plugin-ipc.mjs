/** Keep extension errors as data: contextBridge does not retain Error fields. */
export async function pluginActionResult(service, request) {
  try {
    if (!service || typeof service.action !== 'function') throw Object.assign(Error('扩展服务尚未就绪'), {code: 'PLUGIN_SERVICE_NOT_READY'});
    return await service.action(request);
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'PLUGIN_OPERATION_FAILED';
    const result = {code, message: String(error?.message ?? '扩展操作失败').slice(0, 4000)};
    // Public operation identities only; never forward an arbitrary error object,
    // response headers, stack, credential fields or native process environment.
    if (error?.details && typeof error.details === 'object') {
      const details = {};
      for (const field of ['sourceId', 'id', 'planId', 'phase', 'expectedFingerprint', 'actualFingerprint', 'requiresConfirmation']) {
        const value = error.details[field];
        if (typeof value === 'string' && value.length <= 2000 || typeof value === 'boolean') details[field] = value;
      }
      if (Object.keys(details).length) result.details = details;
    }
    return {error: result};
  }
}
