import pg from 'pg';
import 'dotenv/config';

const { Client } = pg;

const client = new Client({
    connectionString: process.env.DB_URL,
    ssl: { rejectUnauthorized: false }
});

async function updateMessagesSchema() {
    console.log('Connecting to database...');
    await client.connect();
    console.log('Connected!\n');

    try {
        console.log('Updating messages table...');

        await client.query(`
            ALTER TABLE messages 
            ADD COLUMN IF NOT EXISTS reply_to UUID REFERENCES messages(id) ON DELETE SET NULL;
        `);
        console.log('  Added reply_to column');

        await client.query(`
            ALTER TABLE messages 
            ADD COLUMN IF NOT EXISTS reply_content TEXT;
        `);
        console.log('  Added reply_content column');

        await client.query(`
            ALTER TABLE messages 
            ADD COLUMN IF NOT EXISTS reply_sender_phone VARCHAR(15);
        `);
        console.log('  Added reply_sender_phone column');

        await client.query(`
            ALTER TABLE messages 
            ADD COLUMN IF NOT EXISTS reply_sender_name VARCHAR(100);
        `);
        console.log('  Added reply_sender_name column');

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);
        `);
        console.log('  Created index on reply_to');

        const columnsResult = await client.query(`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'messages'
            ORDER BY ordinal_position;
        `);

        console.log('\nMessages table columns:');
        columnsResult.rows.forEach(col => {
            console.log(`  - ${col.column_name} (${col.data_type})`);
        });

        console.log('\nSchema update complete!');
        console.log('Added reply_to, reply_content, reply_sender_phone, reply_sender_name');

    } catch (error) {
        console.error('Error:', error.message);
        console.error(error.stack);
    } finally {
        await client.end();
        console.log('\nDatabase connection closed.');
    }
}

updateMessagesSchema();