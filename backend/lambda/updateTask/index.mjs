import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { UpdateCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

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
    const taskId = event.pathParameters?.taskId || body.taskId;

    if (!taskId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: "taskId is required" })
      };
    }

    const allowedFields = [
      "name",
      "priority",
      "recurring",
      "startedAt",
      "elapsedBeforeMove",
      "scheduledTime"
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    updates.updatedAt = new Date().toISOString();

    const names = {};
    const values = {};
    const parts = [];

    for (const [key, value] of Object.entries(updates)) {
      names["#" + key] = key;
      values[":" + key] = value;
      parts.push("#" + key + " = :" + key);
    }

    const result = await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { userId, taskId },
      UpdateExpression: "SET " + parts.join(", "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW"
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result.Attributes)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        message: "Could not update task",
        error: err.message
      })
    };
  }
};