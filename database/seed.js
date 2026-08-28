// drop-and-seed.js
import pg from 'pg';
import 'dotenv/config';

const { Client } = pg;

const client = new Client({
    connectionString: process.env.DB_URL,
    ssl: { rejectUnauthorized: false }
});

async function resetDatabase() {
    console.log('🔌 Connecting to database...');
    await client.connect();
    console.log('✅ Connected!\n');

    try {
        // Drop tables in correct order (due to foreign keys)
        console.log('🗑️ Dropping existing tables...');
        await client.query(`DROP TABLE IF EXISTS messages CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS conversations CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS users CASCADE;`);
        console.log('✅ Tables dropped\n');

        // Now run the full setup
        console.log('📝 Creating users table...');
        await client.query(`
            CREATE TABLE users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                phone_number VARCHAR(15) UNIQUE NOT NULL,
                name VARCHAR(100) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                is_online BOOLEAN DEFAULT FALSE,
                last_seen TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ Users table created\n');

        console.log('📝 Creating conversations table...');
        await client.query(`
            CREATE TABLE conversations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user1_phone VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                user2_phone VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                last_message_at TIMESTAMP DEFAULT NOW(),
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT unique_conversation UNIQUE (user1_phone, user2_phone)
            );
        `);
        console.log('✅ Conversations table created\n');

        console.log('📝 Creating messages table...');
        await client.query(`
            CREATE TABLE messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                sender_phone VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                receiver_phone VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                content TEXT NOT NULL,
                status VARCHAR(20) DEFAULT 'sent',
                delivered_at TIMESTAMP,
                seen_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ Messages table created\n');

        // Insert test users
        console.log('📝 Inserting test users...');
        await client.query(`
            INSERT INTO users (phone_number, name, password_hash) 
            VALUES 
                ('+919876543210', 'Alice', 'hashed_password_123'),
                ('+919999999999', 'Bob', 'hashed_password_456'),
                ('+919888888888', 'Charlie', 'hashed_password_789')
            ON CONFLICT (phone_number) DO NOTHING;
        `);
        console.log('  ✅ Test users inserted (Alice, Bob, Charlie)\n');

        // Verify
        const result = await client.query(`SELECT phone_number, name, is_online FROM users ORDER BY name;`);
        console.log('👥 Users in database:');
        result.rows.forEach(user => {
            console.log(`   - ${user.name} (${user.phone_number}), online: ${user.is_online}`);
        });

        console.log('\n🎉 Database reset complete!');

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await client.end();
        console.log('🔌 Database connection closed.');
    }
}

resetDatabase();