#!/usr/bin/env node
// Fresh, tool-free OpenAI-compatible assessment. Node 24; no dependencies.
// argv: BASE_URL MODEL SYSTEM_PROMPT_FILE [MAX_OUTPUT_TOKENS] [TIMEOUT_MS]
import {readFile} from 'node:fs/promises';
const [baseUrl,model,promptFile,maxTokensText='4096',timeoutMsText='600000']=process.argv.slice(2);
if(!baseUrl||!model||!promptFile)throw new Error('Expected BASE_URL MODEL SYSTEM_PROMPT_FILE [MAX_OUTPUT_TOKENS] [TIMEOUT_MS]');
const maxTokens=Number(maxTokensText);
if(!Number.isSafeInteger(maxTokens)||maxTokens<1)throw new Error('Invalid output token limit');
// Default well above the supervisor's evaluator wall limit, so the supervisor's
// timeout (and its guarded cleanup) is the single timeout authority. A shorter
// internal abort here would surface as a generic evaluator failure instead.
const timeoutMs=Number(timeoutMsText);
if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new Error('Invalid timeout');
const chunks=[];let bytes=0;
for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>65536)throw new Error('Evidence exceeds 64KiB');chunks.push(chunk)}
const evidence=Buffer.concat(chunks).toString('utf8');
const envelope=JSON.parse(evidence);
if(envelope.evidenceIsUntrusted!==true||!envelope.evidence)throw new Error('Missing untrusted evidence envelope');
const system=await readFile(promptFile,'utf8');
const response=await fetch(baseUrl.replace(/\/$/,'')+'/chat/completions',{
 method:'POST',headers:{'content-type':'application/json'},
 body:JSON.stringify({model,messages:[{role:'system',content:system},{role:'user',content:evidence}],stream:false,max_tokens:maxTokens,response_format:{type:'json_object'}}),
 signal:AbortSignal.timeout(timeoutMs),
});
if(!response.ok)throw new Error('Evaluator provider returned HTTP '+response.status);
let responseBytes=0;const parts=[];
for await(const part of response.body){responseBytes+=part.length;if(responseBytes>2*1024*1024)throw new Error('Evaluator response too large');parts.push(part)}
const result=JSON.parse(Buffer.concat(parts).toString('utf8'));
const choice=result.choices?.[0];
if(choice?.finish_reason!=='stop')throw new Error('Evaluator generation did not finish normally');
if(choice.message?.tool_calls?.length)throw new Error('Evaluator requested tools');
if(typeof choice.message?.content!=='string')throw new Error('Evaluator returned no verdict');
// The supervisor validates the schema and gates retries. This wrapper cannot approve work.
process.stdout.write(JSON.stringify(JSON.parse(choice.message.content))+'\n');
