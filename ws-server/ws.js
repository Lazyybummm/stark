import ws, { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import 'dotenv/config';
import pgclient from "../database/dbconnect.js";
import { json } from "express";

const wss = new WebSocketServer({ port: 8080 });

const mappings = new Map();
const phonelookups = new Map();
const groups = new Map();
groups.set('1', new Set(['1']));

function onlineCheck(receiver_phone) {
    const value = mappings.get(receiver_phone);
    if (value) {
        return 'delivered';
    } else {
        return 'sent';
    }
}


async function removeParticipant(roomId, phone) {
    try {
        const response = await pgclient.query(
            `DELETE FROM group_participants 
             WHERE group_id = $1 AND phone_number = $2
             RETURNING id, group_id, phone_number, joined_at`,
            [roomId, phone]
        );
        if (response.rowCount !== 0) {
            return {
                success: true,
                message: 'user removed from the group'
            };
        } else {
            return {
                success: false,
                message: 'User is not a member of this group'
            };
        }
    } catch (error) {
        return {
            success: false,
            message: error.message
        };
    }
}

async function leaveGroup(phone, groupId) {
    try {
        const response = await pgclient.query(
            `DELETE FROM group_participants 
             WHERE group_id = $1 AND phone_number = $2
             RETURNING id, group_id, phone_number, joined_at`,
            [groupId, phone]
        );
        if (response.rowCount !== 0) {
            // Remove from in-memory mapping
            if (groups.has(groupId)) {
                groups.get(groupId).delete(phone);
                if (groups.get(groupId).size === 0) {
                    groups.delete(groupId);
                }
            }
            return {
                success: true,
                message: "user left the group"
            };
        } else {
            return {
                success: false,
                message: "User is not a member of this group"
            };
        }
    } catch (error) {
        return {
            success: false,
            message: error.message
        };
    }
}


async function createRoom(adminPhone, groupName) {
//fetch any existing group the user is part of based on phone number
//add users entry for that particular group_id , 
try{
const groupResult = await pgclient.query(
    `INSERT INTO groups (group_name, admin_phone) 
     VALUES ($1, $2) 
     RETURNING id, group_name, admin_phone, created_at`,
    [groupName, adminPhone]
);

await pgclient.query(
    `INSERT INTO group_participants (group_id, phone_number) 
     VALUES ($1, $2)`,
    [groupResult.rows[0].id, adminPhone]
);

groups.set(groupResult.rows[0].id,new Set([adminPhone]))
return {
    success:true,
    correctid:groupResult.rows[0].id
}
}
catch(error){
    return {
        success:false,
        error:error.message
    }
}


}

async function addtoRoom(rec_phone, roomId) {
    //insert the udser entry into the db and add them in memory ammpign 
    try{
    const result = await pgclient.query(
        `INSERT INTO group_participants (group_id, phone_number) 
         VALUES ($1, $2) 
         ON CONFLICT (group_id, phone_number) DO NOTHING
         RETURNING id, group_id, phone_number, joined_at`,
        [roomId, rec_phone]
    );

    groups.get(roomId).add(rec_phone)
    return {
        success:true,
        message:"user added to the room"
    }
}
catch(error){
    return {
        success:false,
        error:error.message
    }
}

}

async function sendtoRoom(sender_phone, roomId, content) {
    try{
        //create a global message 
        const messageResult=await pgclient.query(
            `INSERT INTO group_messages (group_id, sender_phone, content) 
             VALUES ($1, $2, $3) 
             RETURNING id, group_id, sender_phone, content, created_at`,
            [roomId, sender_phone, content]
        );
        const msgId=messageResult.rows[0].id;
        const msgReciept=await pgclient.query(
            `INSERT INTO group_message_delivery (message_id, phone_number, status) 
             VALUES ($1, $2, $3)`,
            [msgId, sender_phone, 'sent']
        );
        const participants = groups.get(roomId);
        //filter participants , ignore the sender 

        const arr = [];
        
        for (const phone of participants) {
            //insert entry for each participant
            if(phone==sender_phone) continue;

            await pgclient.query(
                `INSERT INTO group_message_delivery (message_id, phone_number, status) 
                 VALUES ($1, $2, $3)`,
                [msgId, phone, 'sent']
            );
            
            // Get socket for this phone
            const sock = mappings.get(phone);
            if (sock) {
                arr.push(sock);
            }
        }
        arr.forEach((c)=>{
            c.send(JSON.stringify({
                message:messageResult.rows[0],
                event:"group message recieved"
            }))
        })

        return {
            success:true,
            message:"message sent succesfully",
            messageId:messageResult.rows[0].id
        }
    }
    catch(error){
        return {
            success:false,
            message:"error occured with sending your message",
            error:error.message
        }
    }

        //send single tick event to the sender socket
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
                mappings.set(info.phone, socket);//ready to recieve messages
                phonelookups.set(socket, info.phone);
                //group setup 
                //fetch the groups user is participant in 
                const response = await pgclient.query(
                    `SELECT 
                        g.id,
                        g.group_name,
                        g.admin_phone,
                        g.created_at,
                        array_agg(gp.phone_number) as participants
                     FROM groups g
                     JOIN group_participants gp ON g.id = gp.group_id
                     WHERE g.id IN (
                         SELECT group_id FROM group_participants WHERE phone_number = $1
                     )
                     GROUP BY g.id, g.group_name, g.admin_phone, g.created_at`,
                    [info.phone]
                );
                response.rows.forEach((c) => {
                    if (!groups.has(c.id)) {
                        groups.set(c.id, new Set(c.participants));
                    } else {
                        groups.get(c.id).add(info.phone);
                    }
                });
                socket.send(JSON.stringify({
                    message: response.rows,
                    event: "group-data"
                }));

                //update the online status 

            } catch (e) {
                socket.send(JSON.stringify({
                    message: "please login again",
                    event: "auth"
                }));
                socket.close();
            }
        } else if (topic == "chat") {
            const sender_phone = payload.data.sender_phonenum;
            const rec_phone = payload.data.reciever_phonenum;
            const tempid = payload.data.tempid;
            const status = onlineCheck(rec_phone);
            const response = await pgclient.query(
                `SELECT * FROM conversations 
                 WHERE (user1_phone = $1 AND user2_phone = $2)
                    OR (user1_phone = $2 AND user2_phone = $1)`,
                [rec_phone, sender_phone]
            );

            let conversationId;

            if (response.rowCount != 0) {
                conversationId = response.rows[0].id;
                const recipientSocket = mappings.get(rec_phone);
                const messageresult = await pgclient.query(
                    `INSERT INTO messages (conversation_id, sender_phone, receiver_phone, content, status) 
                     VALUES ($1, $2, $3, $4, $5) 
                     RETURNING id, sender_phone, receiver_phone, content, created_at`,
                    [conversationId, sender_phone, rec_phone, payload.data.content, status]
                );
                if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
                    recipientSocket.send(JSON.stringify({
                        content: messageresult.rows[0],
                        event: "chat"
                    }));

                    socket.send(JSON.stringify({
                        correctid: messageresult.rows[0].id,
                        tempid: tempid,
                        status: "delivered"
                    }));
                } else {
                    socket.send(JSON.stringify({
                        correctid: messageresult.rows[0].id,
                        tempid: tempid,
                        status: "sent"
                    }));
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
                const recipientSocket = mappings.get(rec_phone);
                if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
                    recipientSocket.send(JSON.stringify({
                        messageResult: messageResult.rows[0],
                        event: "chat"
                    }));

                    socket.send(JSON.stringify({
                        tempid: tempid,
                        correctid: messageResult.rows[0].id,
                        status: "delivered"
                    }));
                } else {
                    socket.send(JSON.stringify({
                        tempid: tempid,
                        correctid: messageResult.rows[0].id,
                        status: "sent"
                    }));
                }
            }

        } else if (topic == 'typing') {
            const rec_phone = payload.data.reciever_phonenum;
            const recipientSocket = mappings.get(rec_phone);
            if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
                recipientSocket.send(JSON.stringify({
                    sender_phone: payload.data.sender_phone,
                    event: "typing"
                }));
            }

        } else if (topic == 'seen') {
            const messageId = payload.data.messageId;
            const rec_phone = payload.data.rec_phone;
            const recipientSocket = mappings.get(rec_phone);

            await pgclient.query(
                `UPDATE messages SET status = 'seen', seen_at = NOW() 
                 WHERE id = $1`,
                [messageId]
            );

            if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
                recipientSocket.send(JSON.stringify({
                    messageId: messageId,
                    event: "seen"
                }));
            }
        } else if (topic == 'create-room') {
            const data = await createRoom(payload.data.sender_phone, payload.data.group_name);
            if (data.success) {
                socket.send(JSON.stringify({
                    message: "room created succesfully",
                    tempid: payload.data.tempid,
                    correctid: data.correctid
                }));
            } else {
                socket.send(JSON.stringify({
                    message: "something went wrong with the group creation",
                    event: "error",
                    err_msg: data.error


                }));
            }
        } else if (topic == 'addtoroom') {
            const roomId = payload.data.roomId;
            const rec_phone = payload.data.receiver_phone;
            const sender_phone = payload.data.sender_phone;
            const content = await pgclient.query(
                `SELECT id, group_name, admin_phone, created_at, updated_at
                 FROM groups
                 WHERE id = $1`,
                [roomId]
            );
            if (content.rowCount == 0) {
                socket.send(JSON.stringify({
                    message: "room does'nt exists",
                    event: 'invalid room creds'
                }));
                return;
            } else {
                const data = content.rows[0];
                if (data.admin_phone == sender_phone) {
                    const response = await addtoRoom(rec_phone, roomId);
                    if (response.success) {
                        const recipientSocket = mappings.get(rec_phone);
                        if (!recipientSocket) {
                            //do nothing , just notify the sender
                        } else {
                            recipientSocket.send(JSON.stringify({
                                message: "you are added to a room ",
                                groupName: data.group_name,
                                created_at: data.created_at,
                                adminPhone: sender_phone,
                                event: "added to a room"
                            }));
                        }
                        socket.send(JSON.stringify({
                            message: "user added to the room",
                            event: "user added"
                        }));
                    }
                } else {
                    socket.send(JSON.stringify({
                        message: "not authorized to add members",
                        event: "unathorized action"
                    }));
                }
            }
            //the user will provide the phone number 
            //need to check if the user is admin or not , of uyes then call the funciton with the phone number
            //if recipent is connected , sen dthem the event ot update the local state 
            //send the confirmation back to the user that the recipent is connected(even if the db query succeeds only )
        } else if (topic == 'sendtoroom') {
            const roomId = payload.data.roomId;
            const tempmsgId = payload.data.tempmsgId;
            const sender_phone = payload.data.sender_phone;
            const content = payload.data.message;
            const response = await sendtoRoom(sender_phone, roomId, content);
            if (response.success) {
                socket.send(JSON.stringify({
                    message: response.message,
                    tempmsgId: tempmsgId,
                    correctid: response.messageId

                }));
            } else {
                socket.send(JSON.stringify({
                    message: response.message,
                    error: response.error
                }));
            }
        } else if (topic == 'leaveroom') {
            const phone = payload.data.sender_phone;
            const roomId = payload.data.roomId;
            const newAdmin = payload.data.newAdmin;
            if (newAdmin) {
                const assign = await pgclient.query(
                    `UPDATE groups SET admin_phone = $1 WHERE id = $2
                 RETURNING id, group_name, admin_phone, updated_at`,
                    [newAdmin, roomId]
                );
            }
            const response = await leaveGroup(phone, roomId);
            if (response.success) {
                socket.send(JSON.stringify({
                    message: response.message,
                    event: 'left-group'
                }));

                const currentParticipants = groups.get(roomId);
                if (currentParticipants && currentParticipants.size != 0) {

                    currentParticipants.forEach((c) => {
                        const sock = mappings.get(c);
                        sock.send(JSON.stringify({
                            message: phone + 'has left the group',
                            roomId: roomId,
                            event: 'notify others'
                        }));
                    })
                }
            } else {
                socket.send(JSON.stringify({
                    message: response.message,
                    event: 'issue with group leaving'
                }));
            }
        } else if (topic == 'removeuser') {
            const roomId = payload.data.roomId;
            const phone = payload.data.receiver_phone;
            const check = groups.get(roomId).has(phone)
            if (check) {
                const response = await removeParticipant(roomId, phone);
                if (response.success) {
                    groups.get(roomId).delete(phone);
                    const sock = mappings.get(phone);
                    if (sock && sock.readyState === WebSocket.OPEN) {
                        sock.send(JSON.stringify({
                            roomId: roomId,
                            event: 'removed from the group'
                        }));
                        sock.send(JSON.stringify({
                            message: 'user removed from the group',
                            event: 'user removal'
                        }));
                    }
                    const remainingParticipants = groups.get(roomId);
                    if (remainingParticipants && remainingParticipants.size != 0) {
                        remainingParticipants.forEach((c) => {
                            const sock2 = mappings.get(c);
                            if (sock2 && sock2.readyState === WebSocket.OPEN) {
                                sock2.send(JSON.stringify({
                                    message: phone + 'has been removed from the group',
                                    roomId: roomId,
                                    event: 'notify others'
                                }));
                            }
                        })
                    }
                    socket.send(JSON.stringify({
                        message: 'user removed successfully',
                        event: 'removal success'
                    }));
                } else {
                    socket.send(JSON.stringify({
                        message: response.message,
                        event: 'error while removal'
                    }));
                }
                return;
            }
            socket.send(JSON.stringify({
                message: 'user not in group',
                event: 'not participant'
            }))

        }
        else if(topic=='deletegroup'){
            //check if the user is the admin , if yes then delete the entry 
            //remove the entry from the local mapping
            //send a messaeg to all the participants about this 
        }
    });
});

console.log("WebSocket server running on ws://localhost:8080");