# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Real Swarm Model parser/watchdog probe; launched by swarm-tool-heartbeat-probe.mjs."""
import asyncio,json,sys
from openjiuwen.core.foundation.llm import Model,ModelClientConfig,ModelRequestConfig

async def main():
    config=json.loads(sys.stdin.read())
    model=Model(ModelClientConfig(client_provider='OpenAI',api_base=config['url'],api_key=config['token'],stream_idle_timeout=.5,stream_first_chunk_timeout=10,max_retries=0),ModelRequestConfig(model='test'))
    chunks=[]
    try:
        async for chunk in model.stream(messages=[{'role':'user','content':'test'}]): chunks.append(chunk)
    except Exception as exc:
        if config['case']=='stall':
            assert 'stream frame timeout' in str(exc),str(exc)
            print('RESULT '+json.dumps({'case':'stall','status':'correctly timed out'}));return
        raise
    assert config['case']!='stall','Real upstream silence must still time out'
    combined=chunks[0]
    for c in chunks[1:]:combined=combined+c
    calls=combined.tool_calls or []
    if config['case']=='truncated':
        assert not calls,calls
        assert 'output_limit:tool_calls_withheld' in combined.content
    else:
        assert len(calls)==1,calls
        assert json.loads(calls[0].arguments)=={'command':'private-command'}
        assert combined.content=='',combined.content
    print('RESULT '+json.dumps({'case':config['case'],'chunks':len(chunks),'tool_calls':len(calls),'status':'passed'}))
asyncio.run(main())
