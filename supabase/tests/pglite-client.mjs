/** Test-only subset of Supabase's query interface backed by real PostgreSQL. */
export function pgliteClient(db){
 const ident=s=>{if(!/^[a-z_][a-z0-9_]*$/i.test(s))throw Error('Invalid test SQL identifier');return '"'+s+'"';};
 const plain=value=>JSON.parse(JSON.stringify(value));
 return {
  async rpc(name,args){try{
   const values=Object.values(args).map(v=>v&&typeof v==='object'?JSON.stringify(v):v);
   const sql=`select ${ident(name)}(${Object.keys(args).map((k,i)=>`${ident(k)} => $${i+1}`).join(',')}) as value`;
   return {data:plain((await db.query(sql,values)).rows[0].value),error:null};
  }catch(error){return {data:null,error:{message:error.message}};}},
  from(table){
   let columns='*',patch=null,filters=[],order=[],offset=0,limit=null,single=false;
   const q={
    select(v){columns=v;return q;},update(v){patch=v;return q;},
    eq(k,v){filters.push([k,'=',v]);return q;},in(k,v){filters.push([k,'in',v]);return q;},is(k,v){if(v!==null)throw Error('Only null supported');filters.push([k,'null',null]);return q;},
    order(k,opts={}){order.push(ident(k)+(opts.ascending===false?' desc':' asc'));return q;},
    range(a,b){offset=a;limit=b-a+1;return q;},limit(n){limit=n;return q;},maybeSingle(){single=true;return q;},single(){single=true;return q;},
    async then(ok,bad){
     try{
      const values=[];const param=v=>{values.push(v&&typeof v==='object'?JSON.stringify(v):v);return '$'+values.length;};
      const fields=columns==='*'?'*':columns.split(',').map(s=>ident(s.trim())).join(',');
      let sql=patch?`update ${ident(table)} set `+Object.entries(patch).map(([k,v])=>`${ident(k)}=${param(v)}`).join(','):`select ${fields} from ${ident(table)}`;
      const where=filters.map(([k,op,v])=>op==='null'?`${ident(k)} is null`:op==='in'?`${ident(k)} in (${v.map(param).join(',')})`:`${ident(k)}=${param(v)}`);
      if(where.length)sql+=' where '+where.join(' and ');
      if(patch)sql+=' returning '+fields;
      else{if(order.length)sql+=' order by '+order.join(',');if(limit!==null)sql+=' limit '+Number(limit);if(offset)sql+=' offset '+Number(offset);}
      const rows=plain((await db.query(sql,values)).rows);
      return ok({data:single?(rows[0]??null):rows,error:null});
     }catch(error){return ok({data:null,error:{message:error.message}});}
    }
   };return q;
  }
 };
}
