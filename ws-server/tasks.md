things my websocket server should be having 
1.persistence of messages->should be done in a non blocking manner 
2.event handling (done with auth , chat )
3.need to handle the case of the user is offline too , just save into the db (right a seperate message query)




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