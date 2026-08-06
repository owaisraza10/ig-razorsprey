import { google } from 'googleapis';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID!;
const IG_USER_ID = process.env.IG_USER_ID!;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN!;
const DEFAULT_CAPTION = process.env.DEFAULT_CAPTION || 'Check out our latest Reel! 🔥';

// Use Render's persistent disk directory if running live, otherwise local folder
// Use simple local file path so GitHub Actions can save and commit it
const POSTED_LOG_FILE = path.join(__dirname, 'posted_reels.json');

function getPostedIds(): string[] {
    if (!fs.existsSync(POSTED_LOG_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(POSTED_LOG_FILE, 'utf-8'));
    } catch {
        return [];
    }
}

function savePostedId(id: string) {
    const posted = getPostedIds();
    posted.push(id);
    fs.writeFileSync(POSTED_LOG_FILE, JSON.stringify(posted, null, 2));
}

// Initialize Google Drive API (Supports Base64 for Render or local JSON file for testing)
let auth;
if (process.env.GOOGLE_SERVICE_ACCOUNT_BASE64) {
    const decodedCreds = JSON.parse(
        Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8')
    );
    auth = new google.auth.GoogleAuth({
        credentials: decodedCreds,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
} else {
    auth = new google.auth.GoogleAuth({
        keyFile: './google-service-account.json',
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
}
const drive = google.drive({ version: 'v3', auth });

async function runAutomation() {
    try {
        console.log("Checking shared Drive folder for Reels...");
        
        const response = await drive.files.list({
            q: `'${DRIVE_FOLDER_ID}' in parents and mimeType contains 'video/' and trashed = false`,
            orderBy: 'createdTime asc',
            pageSize: 100, 
            fields: 'files(id, name)',
        });

        const files = response.data.files || [];
        const postedIds = getPostedIds();

        const unpostedVideo = files.find(file => file.id && !postedIds.includes(file.id));

        if (!unpostedVideo || !unpostedVideo.id) {
            console.log("No new videos found. All Reels have been posted!");
            return;
        }

        console.log(`Found unposted video: ${unpostedVideo.name} (ID: ${unpostedVideo.id})`);
        const videoUrl = `https://drive.google.com/uc?export=download&id=${unpostedVideo.id}`;

        console.log("Sending video container request to Instagram...");
        const containerRes = await axios.post(
            `https://graph.instagram.com/v20.0/${IG_USER_ID}/media`,
            {
                media_type: 'REELS',
                video_url: videoUrl,
                caption: DEFAULT_CAPTION,
                access_token: IG_ACCESS_TOKEN
            }
        );
        const containerId = containerRes.data.id;

        let isProcessed = false;
        while (!isProcessed) {
            console.log("Waiting for Meta to process the video...");
            await new Promise(resolve => setTimeout(resolve, 15000));

            const statusRes = await axios.get(
                `https://graph.instagram.com/v20.0/${containerId}`,
                { params: { fields: 'status_code', access_token: IG_ACCESS_TOKEN } }
            );

            const status = statusRes.data.status_code;
            if (status === 'FINISHED') {
                isProcessed = true;
            } else if (status === 'ERROR' || status === 'EXPIRED') {
                throw new Error(`Instagram processing failed with status: ${status}`);
            }
        }

        console.log("Publishing Reel to Instagram...");
        const publishRes = await axios.post(
            `https://graph.instagram.com/v20.0/${IG_USER_ID}/media_publish`,
            { creation_id: containerId, access_token: IG_ACCESS_TOKEN }
        );
        console.log(`Successfully published! Post ID: ${publishRes.data.id}`);

        savePostedId(unpostedVideo.id);
        console.log(`Logged video ID to storage.`);

    } catch (error: any) {
        console.error("Automation error:", error.response?.data || error.message);
    }
}

// Continuous 2-Hour Loop for Background Worker
async function startWorker() {
    console.log("Instagram Automation Worker Started.");
    const INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

    while (true) {
        await runAutomation();
        console.log("Waiting 2 hours until the next check...");
        await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
    }
}

runAutomation();