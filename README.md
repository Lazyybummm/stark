# Chat App

A real-time chat application built with a Node.js HTTP backend and a separate WebSocket server, backed by a shared PostgreSQL database hosted on Neon.

## Overview

This project is split into two independently running services that share a single database layer:

- **HTTP Server** (`http-server/`) — handles standard REST API requests (authentication, user management, etc.).
- **WebSocket Server** (`ws-server/`) — handles real-time messaging, typing indicators, delivery/seen status, and online presence.
- **Database Module** (`database/`) — a shared PostgreSQL connection module used by both services.

Both services connect to the same Neon PostgreSQL instance using a shared `.env` configuration and a shared connection pool defined in `database/dbconnect.js`.

## Project Structure

```
chat-app/
├── .env                     # Shared environment variables (not committed)
├── database/
│   └── dbconnect.js         # Shared PostgreSQL connection pool
├── http-server/
│   └── server.js            # REST API server
├── ws-server/
│   └── ws.js                # WebSocket server
└── package.json
```

## Prerequisites

- Node.js (v18 or later recommended)
- npm
- A PostgreSQL database (this project is configured for [Neon](https://neon.tech))

## Installation

1. Clone the repository:

   ```bash
   git clone <repository-url>
   cd chat-app
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a `.env` file in the project root with the following variables:

   ```env
   DB_URL=postgresql://<user>:<password>@<host>/<database>?sslmode=require
   JWT_SECRET_KEY=<your-jwt-secret>
   ```

   Note: the `.env` file must live at the project root, since `database/dbconnect.js` resolves its path relative to its own location on disk (`../env` relative to `database/`), independent of which directory a service is launched from.

## Running the Application

The HTTP server and WebSocket server run as separate processes and should each be started from their own directory.

**Start the HTTP server:**

```bash
cd http-server
nodemon server.js
```

**Start the WebSocket server:**

```bash
cd ws-server
nodemon ws.js
```

The WebSocket server listens on `ws://localhost:8080` by default.

## Database Connection

Both servers import a shared connection from `database/dbconnect.js`. This module:

- Loads environment variables from the root `.env` file using an absolute path derived from the module's own location, ensuring consistent behavior regardless of the working directory a service is started from.
- Establishes a PostgreSQL connection pool using the `DB_URL` environment variable.
- Exposes a shared client/pool instance for use in query execution across both services.

## WebSocket Events

The WebSocket server communicates using JSON-encoded messages with an `event` field indicating the message type.

| Event    | Description                                                              |
|----------|---------------------------------------------------------------------------|
| `auth`   | Authenticates a socket connection using a JWT and associates it with a phone number. |
| `chat`   | Sends a chat message, creates a conversation if one does not exist, and persists the message. |
| `typing` | Notifies the recipient that the sender is currently typing.               |
| `seen`   | Reserved for message read-receipt handling.                               |

## Environment Variables

| Variable         | Description                                  |
|------------------|-----------------------------------------------|
| `DB_URL`         | PostgreSQL connection string (Neon-compatible). |
| `JWT_SECRET_KEY` | Secret key used to verify JSON Web Tokens.    |

## Notes

- The database connection module uses a connection pool rather than a single persistent client, allowing individual connection failures (for example, due to Neon's automatic compute suspension) to be handled gracefully without affecting the entire process.
- Both services must have access to the same `.env` file and the same `database/dbconnect.js` module to function correctly.

## License

This project is currently unlicensed. Add a license file if you intend to distribute or open-source this project.
