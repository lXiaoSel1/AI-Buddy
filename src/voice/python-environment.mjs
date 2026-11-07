import {win32,posix} from 'node:path';

export function pythonFilePath(path,platform=process.platform){
  return platform==='win32'?win32.toNamespacedPath(path):path;
}

/** Portable Python must keep extended-length paths in imported modules' __file__.
 * This is per child process and does not change Windows system policy. */
export function voicePythonEnvironment(assets,environment=process.env,platform=process.platform){
  const paths=platform==='win32'?win32:posix,env={};
  for(const [key,value] of Object.entries(environment))if(/^(SystemRoot|WINDIR|ComSpec|TEMP|TMP|PATH)$/i.test(key))env[key]=value;
  const pathKey=Object.keys(env).find(key=>key.toUpperCase()==='PATH')??'PATH';
  if(assets.ffmpegDirectory)env[pathKey]=[assets.ffmpegDirectory,env[pathKey]].filter(Boolean).join(paths.delimiter);
  const home=paths.dirname(assets.python),site=paths.join(home,'Lib','site-packages');
  return {...env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1',PYTHONHOME:pythonFilePath(home,platform),
    PYTHONPATH:[site,assets.sharedDirectory].filter(Boolean).map(path=>pythonFilePath(path,platform)).join(paths.delimiter)};
}
