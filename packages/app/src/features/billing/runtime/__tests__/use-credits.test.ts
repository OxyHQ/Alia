import {it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({user:{id:'account-a'},activeSessionId:'session-a',isAuthenticated:true}));
const query=vi.hoisted(()=>vi.fn());
const get=vi.hoisted(()=>vi.fn());
vi.mock('@oxy.so/services',()=>({useOxy:()=>state}));
vi.mock('@/shared/api/create-query',()=>({useAuthQuery:query}));
vi.mock('@/shared/api/client',()=>({default:{get}}));
import {useCredits} from '../use-credits';
it('isolates credit reads by current subject/session and rejects an in-flight switched-account response',async()=>{
 query.mockReturnValue({data:undefined,isError:false});
 useCredits();const first=query.mock.calls.at(-1)!;
 state.user={id:'account-b'};state.activeSessionId='session-b';useCredits();const next=query.mock.calls.at(-1)!;
 expect(first[0]).not.toEqual(next[0]);expect(next[3]).toMatchObject({staleTime:0,gcTime:0,enabled:true});
 get.mockResolvedValue({data:{subjectAccountId:'account-b',credits:42}});
 await expect(first[3].queryFn()).rejects.toThrow('account changed');
 await expect(next[3].queryFn()).resolves.toMatchObject({credits:42});
 state.isAuthenticated=false;useCredits();expect(query.mock.calls.at(-1)![3].enabled).toBe(false);
});

it('hides cached allowance on failed refresh',()=>{state.isAuthenticated=true;query.mockReturnValue({data:{productAllowance:{remaining:10000}},isError:true});expect(useCredits().data).toBeUndefined();});
