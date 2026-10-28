// In-memory inference for immutable registration; never writes into the source bundle.
import { infer, validateModel } from './issuance.mjs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function registeredInference({manifest, model, inputs, request}) {
  validateModel(manifest, model);
  return infer(manifest, inputs, async name => {
    if(name!=='main')throw new Error('Unexpected model role');
    return model;
  }, request);
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const chunks=[];let size=0;
    for await(const chunk of process.stdin) {
      // The verified frozen input is ~71 MB; registration is local, not an R2 slice.
      size+=chunk.length;if(size>128*1024*1024)throw new Error('Registration input byte budget');
      chunks.push(chunk);
    }
    const bytes=Buffer.concat(chunks),result=await registeredInference(JSON.parse(bytes));
    result.online_run.registration_transport_sha256=createHash('sha256').update(bytes).digest('hex');
    process.stdout.write(JSON.stringify(result));
  } catch(error) {
    process.stderr.write(JSON.stringify({code:'registration_inference_rejected',message:error.message})+'\n');
    process.exitCode=1;
  }
}
