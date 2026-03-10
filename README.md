### Project
Minimal MCP server that enables an MCP client (such as Cursor) to interact with a single Amazon S3 bucket.

The server exposes tools for listing objects, retrieving text files, uploading text content, and deleting objects.

All operations are scoped to one configured bucket defined through environment variables.


---

### Tools
The MCP server exposes the following tools:

- `list_objects` – list objects in the configured bucket (optionally by prefix)
- `get_object` – retrieve a text object by key
- `put_object` – upload text content to a key
- `delete_object` – delete an object by key

`get_object` currently supports **text-based files only**.

---

### Technologies
- Node.js
- TypeScript
- Model Context Protocol SDK (`@modelcontextprotocol/sdk`)
- AWS SDK v3 (`@aws-sdk/client-s3`)
- Zod (runtime input validation)
- dotenv (environment configuration)
- LocalStack (local S3 testing)

---

## Setup

### Environment configuration

Create a `.env` file in the project root:


BUCKET_NAME=mcp-test-bucket
S3_ENDPOINT=http://localhost:4566

AWS_REGION=us-east-1

AWS_ACCESS_KEY_ID=test

AWS_SECRET_ACCESS_KEY=test


---

### Install

#### Install dependencies:


npm install

npm run build

#### Run the MCP server:


node dist/index.js


The server listens for MCP requests via **stdio transport**.

---

## LocalStack Setup

### Start LocalStack with S3 enabled:


docker run --rm -it -p 4566:4566 -e SERVICES=s3 localstack/localstack


### Create a test bucket:


aws --endpoint-url=http://localhost:4566
 s3api create-bucket --bucket mcp-test-bucket


### Upload a sample file:


echo hello world > hello.txt
aws --endpoint-url=http://localhost:4566
 s3 cp hello.txt s3://mcp-test-bucket/hello.txt


### Verify bucket contents:


aws --endpoint-url=http://localhost:4566
 s3 ls s3://mcp-test-bucket/


---

## MCP Tool Examples

### List objects:


Use list_objects to show all objects in bucket


### Retrieve a text object:


Use get_object key="hello.txt"


### Upload text content:


Use put_object key="test.txt" bodyText="hello world"


### Delete an object:


Use delete_object key="test.txt"


---
