import ws, { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import 'dotenv/config';
import pgclient from "../database/dbconnect.js";

const wss = new WebSocketServer({ port: 8080 });

const mappings = new Map();
const phonelookups = new Map();

function onlineCheck(receiver_phone) {
    const value = mappings.get(receiver_phone);
    if (value) {
        return 'delivered';
    } else {
        return 'sent';
    }
}

wss.on("connection", async (socket) => {
    socket.send("connected");

    socket.on("close", async () => {
        const phone_number = phonelookups.get(socket);
        const sock = mappings.get(phone_number);
        phonelookups.delete(sock);
        mappings.delete(phone_number);
        await pgclient.query(
            `UPDATE users SET is_online = false, last_seen = NOW() 
             WHERE phone_number = $1`,
            [phone_number]
        );
    });

    socket.on("message", async (data) => {
        const payload = JSON.parse(data.toString('utf8'));
        const topic = payload.event;
        if (topic == "auth") {
            try {
                const info = jwt.verify(payload.data, process.env.JWT_SECRET_KEY);
                mappings.set(info.phone, socket);
                phonelookups.set(socket, info.phone);

            } catch (e) {
                socket.send(JSON.stringify({
                    message: "please login again",
                    event:"auth"

                }));
                socket.close();
            }
        } else if (topic == "chat") {
            const sender_phone = payload.data.sender_phonenum;
            const rec_phone = payload.data.reciever_phonenum;
            const tempid=payload.data.tempid;
            const status = onlineCheck(rec_phone);
            const response = await pgclient.query(
                `SELECT * FROM conversations 
                 WHERE (user1_phone = $1 AND user2_phone = $2)
                    OR (user1_phone = $2 AND user2_phone = $1)`,
                [rec_phone, sender_phone]
            );

            let conversationId;

            if (response.rowCount != 0) {//conversation exists 
                conversationId = response.rows[0].id;
                const recipientSocket = mappings.get(rec_phone);
                const messageresult=await pgclient.query(//whenever i do insert , i get the entry i just added as a return value 
                    `INSERT INTO messages (conversation_id, sender_phone, receiver_phone, content, status) 
                     VALUES ($1, $2, $3, $4, $5) 
                     RETURNING id, sender_phone, receiver_phone, content, created_at`,
                    [conversationId, sender_phone, rec_phone, payload.data.content, status]
                );
                if(recipientSocket){

                    recipientSocket.send(JSON.stringify({
                        content: messageresult.rows[0],
                        event:"chat"
                    }))

                    socket.send(JSON.stringify({
                        correctid:messageresult.rows[0].id,
                        tempid:tempid,
                        status:"delivered"
                    }))
                }
                else{
                    socket.send(JSON.stringify({
                        correctid:messageresult.rows[0].id,
                        tempid:tempid,
                        status:"sent"
                    }))
                }
            } else {
                const newConvo = await pgclient.query(
                    `INSERT INTO conversations (user1_phone, user2_phone, last_message_at) 
                     VALUES ($1, $2, NOW()) 
                     RETURNING id`,
                    [sender_phone, rec_phone]
                );
                conversationId = newConvo.rows[0].id;

                const messageResult = await pgclient.query(
                    `INSERT INTO messages (conversation_id, sender_phone, receiver_phone, content, status) 
                     VALUES ($1, $2, $3, $4, $5) 
                     RETURNING id, conversation_id, sender_phone, receiver_phone, content, created_at`,
                    [conversationId, sender_phone, rec_phone, payload.data.content, status]
                );
                const recipientSocket=mappings.get(rec_phone);
                if(recipientSocket){
                    
                recipientSocket.send(JSON.stringify({
                    messageResult:messageResult.rows[0],
                    event:"chat"
                }))

                socket.send(JSON.stringify({
                    tempid:tempid,
                    correctid:messageResult.rows[0].id,
                    status:"delivered"
                }))
            }
            else{
                socket.send(JSON.stringify({
                    tempid:tempid,
                    correctid:messageResult.rows[0].id,
                    status:"sent"
                }))
            }
            }

        } else if (topic == 'typing') {//this logic would work for only the case of two  users , not for a group 

            const rec_phone = payload.data.reciever_phonenum;
            const recipientSocket = mappings.get(rec_phone);
            if (!recipientSocket) {
                //do nothing 
            }
            recipientSocket.send(JSON.stringify({
                sender_phone: payload.data.sender_phone,
                event:"typing"
            }))

            
        } else if (topic == 'seen') {
            const messageId=payload.data.messageId//recieved from the client 
            const rec_phone=payload.data.rec_phone;
            const recipientSocket=mappings.get(rec_phone);
             await pgclient.query("UPDATE messages WHERE ")
             recipientSocket.send(JSON.stringify({
                messageId:messageId,
                event:"seen"
             }))

            //recieve the conversation id and message id 
            //first send the status of which messaeg is seen to th reciever 
            //store it in the db 
        }
    });
});

console.log("WebSocket server running on ws://localhost:8080");