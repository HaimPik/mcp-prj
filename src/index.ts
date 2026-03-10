import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod"; //runtime input validation for MCP tool arguments
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

const BUCKET = process.env.BUCKET_NAME?.trim();

if (!BUCKET) {
  console.error("Missing required env var BUCKET_NAME");
  process.exit(1);
}

const S3_ENDPOINT = process.env.S3_ENDPOINT?.trim();
const REGION =process.env.AWS_REGION?.trim();

if (!REGION) {
  console.error("Missing required env var region");
  process.exit(1);
}
const s3 = new S3Client({
  region: REGION ,
  endpoint: S3_ENDPOINT || undefined,
  forcePathStyle: Boolean(S3_ENDPOINT),
});


//helper to generate a standardized MCP error res
function userError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
//map of standard aws error for easy debugging
function mapAwsError(err: any, context: string) {
  const name = err?.name;
  const status = err?.$metadata?.httpStatusCode;

  if (name === "AccessDenied" || status === 403) {
    return userError(`Access denied: ${context}. Check IAM permissions for this bucket/key.`);
  }
  if (name === "NoSuchKey" || status === 404) {
    return userError(`Not found: ${context}.`);
  }
  if (name === "NoSuchBucket") {
    return userError(`Bucket not found: "${BUCKET}". Check BUCKET_NAME.`);
  }

  const msg = err?.message ? String(err.message) : String(err);
  return userError(`Error: ${context}. ${msg}`);
}



/*
AWS S3 GetObject returns the file body as a stream or other binary type
this func normalizes it and converts the result into a UTF-8 string
*/
async function streamToString(body: any): Promise<string> {
  if (!body) return "";

  if (typeof body.transformToString === "function") {
    return await body.transformToString("utf-8");
  }

  if (typeof body.transformToByteArray === "function") {
    const arr = await body.transformToByteArray();
    return Buffer.from(arr).toString("utf-8");
  }

  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  if (Buffer.isBuffer(body)) {
    return body.toString("utf-8");
  }

  return String(body);
}

const server = new McpServer({ name: "mcp-s3-bucket", version: "1.0.0" });

/*
this tool lists objects inside the configured bucket.
supports prefix filtering for dummy file systen structure (ex festch all files in docs: docs/hello, docs/some-important-doc.. ) 
supports pagination with ContinuationToken and maxKeys input < num of keys in bucket.
*/
server.registerTool(
  "list_objects",
  {
    title: "List S3 objects",
    description: "List objects under an optional prefix in the configured bucket.",
    inputSchema: {
      prefix: z.string().optional(),
      maxKeys: z.number().int().min(1).max(1000).optional(),
      continuationToken: z.string().optional(),
    },
  },
  async ({ prefix, maxKeys, continuationToken }) => {
    try {
      const out = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: prefix,
          MaxKeys: maxKeys,
          ContinuationToken: continuationToken,
        }),
      );
      //normalize aws response to cleaner structure
      const objects =
        out.Contents?.map((o) => ({
          key: o.Key ?? "",
          size: o.Size ?? 0,
          lastModified: o.LastModified ? o.LastModified.toISOString() : undefined,
        })) ?? [];

      const structuredContent = {
        bucket: BUCKET,
        prefix: prefix ?? "",
        objects,
        isTruncated: Boolean(out.IsTruncated),
        nextContinuationToken: out.NextContinuationToken,
      };

      //make readable output shown in MCP clients
      const keyList =
        objects.length === 0
          ? "No objects found."
          : objects.map((o) => `- ${o.key}`).join("\n");

      return {
        content: [
          {
            type: "text",
            text:
              `Found ${objects.length} object(s) in bucket "${BUCKET}"` +
              (prefix ? ` with prefix "${prefix}"` : "") +
              `:\n\n${keyList}`,
          },
        ],
        structuredContent,
      };
    } catch (err) {
      return mapAwsError(err, `listing objects${prefix ? ` with prefix "${prefix}"` : ""}`);
    }
  },
);
//retrieve file from bucket via key, binary files are rejected to avoid returning unreadable data to MCP clients
server.registerTool(
  "get_object",
  {
    title: "Get S3 object",
    description: "Get a text object by key from the configured bucket.",
    inputSchema: {
      key: z.string().min(1, "key is required"),
    },
  },
  async ({ key }) => {
    try {
      const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));

      const contentType = out.ContentType ?? ""; 
      //isText check needed to ensure we only work with text file so utf-8 conversion works and not producing garbage 
      const isText =                                      
        contentType.startsWith("text/") ||
        contentType.includes("json") ||
        contentType.includes("xml") ||
        key.endsWith(".txt");

      if (!isText) {
        return userError(
          `Object "${key}" is not a supported text file${contentType ? ` (content-type: ${contentType})` : ""}.`,
        );
      }

      const text = await streamToString(out.Body);

      const structuredContent = {
        bucket: BUCKET,
        key,
        contentType: out.ContentType,
        contentLength: out.ContentLength,
        etag: out.ETag,
        text,
      };

      return {
        content: [
          {
            type: "text",
            text:
              `Downloaded text object "${key}"` +
              (out.ContentType ? `, content-type: ${out.ContentType}` : "") +
              `.\n\n${text}`,
          },
        ],
        structuredContent,
      };
    } catch (err) {
      return mapAwsError(err, `getting object "${key}"`);
    }
  },
);


//uplaod text content into the bucket at the specified key
server.registerTool(
  "put_object",
  {
    title: "Put S3 object",
    description: "Upload text content to a key in the configured bucket.",
    inputSchema: {
      key: z.string().min(1, "key is required"),
      bodyText: z.string(),
      contentType: z.string().optional(),
    },
  },
  async ({ key, bodyText, contentType }) => {
    try {
      const body = Buffer.from(bodyText, "utf8");

      const out = await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: body,
          ContentType: contentType ?? "text/plain; charset=utf-8",
        }),
      );

      const structuredContent = { bucket: BUCKET, key, etag: out.ETag };

      return {
        content: [{ type: "text", text: `Uploaded "${key}" (${body.length} bytes).` }],
        structuredContent,
      };
    } catch (err) {
      return mapAwsError(err, `putting object "${key}"`);
    }
  },
);

//remove obj from the configured bucket
server.registerTool(
  "delete_object",
  {
    title: "Delete S3 object",
    description: "Delete an object by key from the configured bucket.",
    inputSchema: {
      key: z.string().min(1, "key is required"),
    },
  },
  async ({ key }) => {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));

      const structuredContent = { bucket: BUCKET, key, deleted: true };

      return {
        content: [{ type: "text", text: `Deleted "${key}".` }],
        structuredContent,
      };
    } catch (err) {
      return mapAwsError(err, `deleting object "${key}"`);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);