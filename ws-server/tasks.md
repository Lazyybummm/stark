things my websocket server should be having 
1.persistence of messages->should be done in a non blocking manner 
2.event handling (done with auth , chat )
3.need to handle the case of the user is offline too , just save into the db (right a seperate message query)
4.the frontend should handle that when the user sees the senders message only then the seen event shoud be fired for that message 
5.for a group i hink i need to add an array of users , if one user types , i will query the conversation , will loop thorigh the fetches array and send to the repsective sockets , the messe sor any other event->how will i handle the message reading in this case




//conversation flow ->
    user searches up a name , a call should be made to the db , if converstaion exists , if not create one 
    conversation schema should be :
        {
            id 
            user 1 id (foreign keys to the user primary key in the user table , a nested query will be run to get the metdata)
            user 2 id 
            messages_id id (all the messages will be dumped here )
        }



        //messages schema 
            {
                id 
                conversation id 
                sender id
                reciever id(if single person else the group id )
                timestamp 
                content 
                status (seen , unseen , delivered , not delivered) ->how will i do it , i check whteher a user is onine or not whether or not they are cnnected ti the wss or not 
            }



            select * from messagees where convo id is this (should page the results to avoid the network overhead and overload on the user devive at once ) 
            filter by timestap based on how much the user has viewed it ->YOU SEND IT ON THE FLY AND LET THE WRKER HANDLE THE DB UPDATES




//case when user comes online 
task ={
    event:fetchmessages,
    user_phone:phonenumber
}


//dotenv looks for the env in the current folder where it is run 


group chat schema ->
group chat {
    id 
    admin phone adminphone
    time at which this was created 
}


group chat functionalities:
1.how to hadle this at a ws level 
a.online->
b.offline->online->user joins the ws , i need to run a query (either do ths at the http level or at the auth , when the auth succeeds , i am gonna fetch all the group id where the user is part of ) , fetched some array or so , will loop it like groupmapping for each add correspdonign user socket ,



return in ws block the exctuion flow , 
postgres query returns a array 