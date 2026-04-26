import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

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

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { userId, taskId }
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Task deleted",
        taskId
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        message: "Could not delete task",
        error: err.message
      })
    };
  }
};