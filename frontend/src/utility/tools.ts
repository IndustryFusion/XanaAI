// 
// Copyright (c) 2025 Industry Fusion Foundation
// 
// Licensed under the Apache License, Version 2.0 (the "License"); 
// you may not use this file except in compliance with the License. 
// You may obtain a copy of the License at 
// 
//   http://www.apache.org/licenses/LICENSE-2.0 
// 
// Unless required by applicable law or agreed to in writing, software 
// distributed under the License is distributed on an "AS IS" BASIS, 
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. 
// See the License for the specific language governing permissions and 
// limitations under the License. 
// 

import axios from "axios";
import { createHash } from "crypto";
import { CompactEncrypt, compactDecrypt } from 'jose';
import { RefObject } from "react";
import { Toast } from "primereact/toast";

const XANA_BACKEND_URL = process.env.NEXT_PUBLIC_API_BASE;

if (!process.env.NEXT_PUBLIC_JWT_SECRET) {
    throw new Error('NEXT_PUBLIC_JWT_SECRET is not set.');
}
const ENCRYPTION_KEY: Uint8Array = deriveKey(process.env.NEXT_PUBLIC_JWT_SECRET);

interface LoginData {
    ifricdi: string;
    company_ifric_id: string;
    user_name: string;
    jwt_token: string;
    user_role: string;
    access_group: string;
    access_group_Ifric_Dashboard: string;
    user_email: string;
}

function deriveKey(secret: string): Uint8Array {
    const hash = createHash('sha256');
    hash.update(secret);
    return new Uint8Array(hash.digest());
}


export const showToast = (
    toast: RefObject<Toast>, severity: "success" | "info" | "warn" | "error", summary: string, message: string): void => {
        if (toast.current) {
            toast.current.show({ severity, summary, detail: message, life: 3000 });
        } else {
            console.warn(
                "Toast component is not available. Message:",
                summary,
                message
            );
        }
};

export const getAccessGroupData = async(token: string) => {
    try {
        const registryHeader = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`
        };
        const response = await axios.post(`${XANA_BACKEND_URL}/query/get-indexed-db-data`, {token, product_name: "XANA AI"}, {
            headers: registryHeader
        });
        await storeAccessGroup(response.data.data);
        return { status: 200, message: "stored data successfully"}
    } catch(error: any) {
        throw error;
    }
}


async function encryptJWT(jwt: string) {
    const encoder = new TextEncoder();
    const jwe = await new CompactEncrypt(encoder.encode(jwt))
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
        .encrypt(ENCRYPTION_KEY);
    return jwe;
}


function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("myDatabase");

        request.onupgradeneeded = function (event) {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains("accessGroupStore")) {
                db.createObjectStore("accessGroupStore", { keyPath: "id" });
            }
        };

        request.onsuccess = function (event) {
            const db = (event.target as IDBOpenDBRequest).result;
            resolve(db);
        };

        request.onerror = function (event) {
            reject("Database error: " + (event.target as IDBOpenDBRequest).error);
        };
    });
}

export async function storeAccessGroup(loginData: LoginData) : Promise<void> {
    try {
        const encryptedJWT = await encryptJWT(loginData.jwt_token);
        const db = await openDatabase();
        const transaction = db.transaction(["accessGroupStore"], "readwrite");
        const objectStore = transaction.objectStore("accessGroupStore");

        const dataToStore = {
            id: "accessGroup",
            company_ifric_id: loginData.company_ifric_id,
            user_name: loginData.user_name,
            jwt_token: encryptedJWT,
            ifricdi: loginData.ifricdi,
            user_role: loginData.user_role,
            access_group: loginData.access_group,
            access_group_Ifric_Dashboard: loginData.access_group_Ifric_Dashboard,
            user_email: loginData.user_email
        };

        const request = objectStore.put(dataToStore);

        return new Promise<void>((resolve, reject) => {
            const request  = objectStore.put(dataToStore);
            request.onsuccess = function () {
                console.log("Access group data stored successfully");
                resolve();
            };

            request.onerror = function (event) {
                console.error("Error storing access group data: " + (event.target as IDBRequest).error);
                reject(new Error("Failed to store access group data"));
            };
        });
    } catch (error) {
        console.error(error);
        throw error;
    }
}