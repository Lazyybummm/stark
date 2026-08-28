import pg, { Client } from "pg"
import 'dotenv/config'
console.log(process.env.DB_URL)
const pgclient=new Client({connectionString:process.env.DB_URL})
try{
    await pgclient.connect();
    console.log("connection succesfull")//the control reaches here only fi the connection is succesfull
    
}
catch(e){
    console.log("an error occured");
    throw(e);
}
export default pgclient;