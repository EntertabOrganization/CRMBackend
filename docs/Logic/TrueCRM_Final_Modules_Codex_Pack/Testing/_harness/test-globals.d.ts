declare function describe(name:string, fn:()=>void):void;
declare function it(name:string, fn:()=>Promise<void>|void):void;
declare function expect(value:unknown): {toBe:(value:unknown)=>void; toBeGreaterThan:(value:number)=>void; toEqual:(value:unknown)=>void};
