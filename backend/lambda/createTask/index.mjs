import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME || "PriorityTasks";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE"
};

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");

    const userId = body.userId || "demo-user";
    const taskId = crypto.randomUUID();

    const task = {
      userId,
      taskId,
      name: body.name || body.title || "Untitled Task",
      priority: body.priority || "dz",
      recurring: body.recurring ?? false,
      startedAt: body.startedAt ?? null,
      elapsedBeforeMove: body.elapsedBeforeMove ?? 0,
      scheduledTime: body.scheduledTime || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: task
    }));

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify(task)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        message: "Could not create task",
        error: err.message
      })
    };
  }
};