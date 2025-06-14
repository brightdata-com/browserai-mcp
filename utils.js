'use strict';

export function create_api_headers(package_json, api_token) {
    return () => {
        const headers = new Headers();
        headers.append('user-agent', `${package_json.name}/${package_json.version}`);
        headers.append('authorization', `apikey ${api_token}`);
        headers.append('Content-Type', 'application/json');
        return headers;
    };
}

function loading_progress(idx) {
    if (idx < 10) return idx * (Math.floor(Math.random() * 4) + 2);
    if (idx < 20) return 50 + (idx - 10) * 3; 
    if (idx < 25) return 80 + (idx - 20) * 2; 
    if (idx < 32) return 90 + (idx - 25) * 1; 
    return 99;
}

export async function poll_task_result(task_id, headers_fn, { log, reportProgress, instructions }) {
    let idx = 0;
    const startTime = Date.now();
    while (true)
    {
        const url = `https://browser.ai/api/v1/tasks/${task_id}`;
        const instruction = instructions[0]?.action || 'unknown';
        const response = await fetch(url, {method: 'GET', headers: headers_fn()});
        const result_data = await response.json();
        const elapsed_sec = Math.floor((Date.now() - startTime) / 1000);
        log.info(`Executing instruction "${instruction}". Status: ${result_data.status}. Progress: ${loading_progress(idx)}%, Time: ${elapsed_sec}s`);
        if (typeof reportProgress === 'function') 
        {
            reportProgress({ 
                progress: `${idx++}`, 
                total: `100`, 
                message: `Executing instruction "${instruction}". Status: ${result_data.status}. Progress: ${loading_progress(idx)}%, Time: ${elapsed_sec}s`     
            });
        }
        if (['finalized', 'awaiting', 'stopped'].includes(result_data.status)) 
        {
            reportProgress({ 
                progress: 100, 
                total: 100, 
                message: `Task "${instruction}" successfully completed. Execution time: ${elapsed_sec}s`
            });
            log.info(`Task "${instruction}" successfully completed. Execution time: ${elapsed_sec}s`, { task_id, result: result_data.result });
            return result_data.result;
        }
        if (result_data.status == 'failed') 
        {
            log.error('Task poll failed', { task_id, error: result_data.error });
            reportProgress({ 
                progress: 100, 
                total: 100, 
                message: `Task "${instruction}" failed.`
            });
            throw new Error(`Task ${task_id} failed: ${result_data.error}`);
        }
        await new Promise(resolve=>setTimeout(resolve, 3000));
    }
}

export async function send_session_instructions(executionId, instructions, headers_fn, { log, reportProgress }, project_name) {
    const url = `https://browser.ai/api/v1/tasks/${executionId}/instructions`;
    const body = {
        geoLocation: {country: 'US'},
        awaitable: true,
        instructions,
        project: project_name,
        type: 'crawler_automation',
    };
    log.info('Sending instructions to session', { url, executionId, instructionsCount: instructions.length });
    let response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: headers_fn(),
    });
    if (!response.ok) 
    {
        const error = await response.text();
        log.error('Failed to send instructions', { status: response.status, statusText: response.statusText, error });
        throw new Error(`Failed to send instructions: ${response.status} ${response.statusText} - ${error}`);
    }
    const data = await response.json();
    const task_id = data.executionId;
    await new Promise(resolve=>setTimeout(resolve, 1000));
    log.info('Received task ID from API after sending instructions', { task_id, responseData: data });
    if (task_id) 
    {
        let result = await poll_task_result(task_id, headers_fn, { log, reportProgress, instructions });
        return {
            content: [{
                type: "text",
                text: JSON.stringify({executionId: task_id, result}, null, 2)
            }]
        };
    }
    log.error('No task_id received after sending instructions', { responseData: data });
    throw new Error('No task ID received from API after sending instructions');
}

export function create_tool_fn(debug_stats) {
    return (name, fn) => {
        return async (params, executionContext) => {
            const { log } = executionContext;
            debug_stats.tool_calls[name] = (debug_stats.tool_calls[name] || 0) + 1;
            const ts = Date.now();
            log.info(`[${name}] Executing tool`, { params });
            try {
                return await fn(params, executionContext);
            } catch(e) {
                if (e.response) {
                    let error_text = '';
                    try {
                        error_text = await e.response.text();
                    } catch (textError) {
                        log.error(`[${name}] Failed to get error response text`, { textError });
                    }
                    log.error(`[${name}] HTTP error`, { status: e.response.status, statusText: e.response.statusText, body: error_text });
                    if (error_text?.length) {
                        throw new Error(`HTTP ${e.response.status}: ${error_text}`);
                    }
                    throw new Error(`HTTP ${e.response.status}: ${e.response.statusText || 'Unknown HTTP error'}`);
                } else if (e.name === 'FetchError' || e instanceof TypeError) {
                    log.error(`[${name}] Fetch error`, e);
                    throw new Error(`Network error: ${e.message}`);
                } else {
                    log.error(`[${name}] Unexpected error`, e);
                }
                throw e;
            } finally {
                const dur = Date.now() - ts;
                log.info(`[${name}] Tool finished`, { duration_ms: dur });
            }
        };
    };
}
