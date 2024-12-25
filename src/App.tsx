import { useState, useEffect, useRef } from 'react';
import { Background } from './components/Background';
import { PasswordView } from './components/PasswordView';
import * as kdbxweb from 'kdbxweb';
import { Database, Group } from './types/database';
import './App.css';
import { TitleBar } from './components/TitleBar';

declare var argon2: any;

// Initialize Argon2 implementation for kdbxweb
kdbxweb.CryptoEngine.argon2 = async (password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number, _version: number) => {
	try {
		const result = await argon2.hash({
			pass: new Uint8Array(password),
			salt: new Uint8Array(salt),
			time: iterations,
			mem: memory,
			parallelism,
			type,
			hashLen: length
		});
		return result.hash;
	} catch (err) {
		console.error('Argon2 error:', err);
		throw err;
	}
};

function App() {
	const [selectedFile, setSelectedFile] = useState<File | null>(null)
	const [isDragging, setIsDragging] = useState(false)
	const [showPassword, setShowPassword] = useState(false)
	const [password, setPassword] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [database, setDatabase] = useState<Database | null>(null)
	const [isLoading, setIsLoading] = useState(false)
	const passwordInputRef = useRef<HTMLInputElement>(null);
	const [searchQuery, setSearchQuery] = useState('')
	const [isCreatingNew, setIsCreatingNew] = useState(false)
	const [confirmPassword, setConfirmPassword] = useState('')
	const [databaseName, setDatabaseName] = useState('New Database')
	const [databasePath, setDatabasePath] = useState<string | null>(null)
	// Keep a reference to the loaded KeePass database
	const [kdbxDb, setKdbxDb] = useState<kdbxweb.Kdbx | null>(null);

	useEffect(() => {
		if (selectedFile) {
			passwordInputRef.current?.focus();
		}
	}, [selectedFile]);

	const handleDragOver = (e: React.DragEvent) => {
		e.preventDefault()
		setIsDragging(true)
	}

	const handleDragLeave = (e: React.DragEvent) => {
		e.preventDefault()
		setIsDragging(false)
	}

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault()
		setIsDragging(false)

		const files = e.dataTransfer.files
		if (files.length > 0) {
			setSelectedFile(files[0])
			setError(null)
		}
	}

	const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files
		if (files && files.length > 0) {
			setSelectedFile(files[0])
			setError(null)
		}
	}

	const convertKdbxToDatabase = (kdbxDb: kdbxweb.Kdbx): Database => {
		const convertGroup = (group: kdbxweb.KdbxGroup): Group => {
			return {
				id: group.uuid.toString(),
				name: group.name as string,
				groups: group.groups.map(g => convertGroup(g)),
				entries: group.entries.map(entry => ({
					id: entry.uuid.toString(),
					title: entry.fields.get('Title')?.toString() || '',
					username: entry.fields.get('UserName')?.toString() || '',
					password: entry.fields.get('Password') || '',
					url: entry.fields.get('URL')?.toString(),
					notes: entry.fields.get('Notes')?.toString(),
					created: entry.times.creationTime as Date,
					modified: entry.times.lastModTime as Date,
				})),
			};
		};

		const root = convertGroup(kdbxDb.getDefaultGroup());
		return {
			name: kdbxDb.meta.name || 'KeePass Database',
			groups: root.groups,
			root: {
				...root,
				name: 'All Entries'
			},
		};
	};

	const handleUnlock = async () => {
		if (!selectedFile) return

		setIsLoading(true)
		setError(null)

		try {
			const fileBuffer = await selectedFile.arrayBuffer()
			const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password))

			const db = await kdbxweb.Kdbx.load(
				new Uint8Array(fileBuffer).buffer,
				credentials
			)

			const convertedDb = convertKdbxToDatabase(db)
			setDatabase(convertedDb)
			setKdbxDb(db);  // Store the KeePass database
			
			// Try to get the full path from electron
			if (window.electron) {
				const fullPath = await window.electron.getFilePath(selectedFile.name);
				if (fullPath) {
					setDatabasePath(fullPath);
				}
				// If we can't get the path, we'll wait until the user makes changes
				// before asking where to save
			}
		} catch (err) {
			console.error('Failed to unlock database:', err)
			setError('Invalid password or corrupted database file')
		} finally {
			setIsLoading(false)
		}
	}

	const handleLock = () => {
		setDatabase(null)
		setSelectedFile(null)
		setPassword('')
		setError(null)
		setDatabasePath(null)
		setKdbxDb(null)  // Clear the KeePass database
	}

	const handleCreateNew = async () => {
		if (password !== confirmPassword) {
			setError('Passwords do not match')
			return
		}
		if (password.length < 8) {
			setError('Password must be at least 8 characters long')
			return
		}
		if (!databaseName.trim()) {
			setError('Database name is required')
			return
		}

		setIsLoading(true)
		setError(null)

		try {
			const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password))
			const db = kdbxweb.Kdbx.create(credentials, databaseName.trim())

			// Save the database
			const arrayBuffer = await db.save();
			const result = await window.electron?.saveFile(new Uint8Array(arrayBuffer));

			if (!result?.success) {
				throw new Error(result?.error || 'Failed to save database');
			}

			const convertedDb = convertKdbxToDatabase(db)
			setDatabase(convertedDb)
			if (result.filePath) {
				setDatabasePath(result.filePath);
			}
		} catch (err) {
			console.error('Failed to create database:', err)
			setError(err instanceof Error ? err.message : 'Failed to create database')
		} finally {
			setIsLoading(false)
		}
	}

	const handleKeyPress = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter' && !isLoading) {
			if (isCreatingNew) {
				handleCreateNew();
			} else if (selectedFile) {
				handleUnlock();
			}
		}
	};

	const handleDatabaseChange = async (updatedDatabase: Database) => {
		setDatabase(updatedDatabase);

		try {
			if (!kdbxDb) {
				throw new Error('Database not loaded');
			}

			// Update the entries in the existing database
			const updateGroup = (group: Group, kdbxGroup: kdbxweb.KdbxGroup) => {
				// Clear existing entries
				while (kdbxGroup.entries.length > 0) {
					kdbxGroup.entries.pop();
				}

				// Add updated entries
				group.entries.forEach(entry => {
					const kdbxEntry = kdbxDb.createEntry(kdbxGroup);
					kdbxEntry.fields.set('Title', entry.title);
					kdbxEntry.fields.set('UserName', entry.username);
					kdbxEntry.fields.set('Password', typeof entry.password === 'string' 
						? kdbxweb.ProtectedValue.fromString(entry.password)
						: entry.password
					);
					if (entry.url) kdbxEntry.fields.set('URL', entry.url);
					if (entry.notes) kdbxEntry.fields.set('Notes', entry.notes);
					kdbxEntry.times.creationTime = entry.created;
					kdbxEntry.times.lastModTime = entry.modified;
				});

				// Update subgroups recursively
				group.groups.forEach((subgroup, index) => {
					const kdbxSubgroup = kdbxGroup.groups[index] || kdbxDb.createGroup(kdbxGroup, subgroup.name);
					updateGroup(subgroup, kdbxSubgroup);
				});
			};

			const root = kdbxDb.getDefaultGroup();
			if (root) {
				updateGroup(updatedDatabase.root, root);
			}

			// Save the updated database
			const arrayBuffer = await kdbxDb.save();
			
			let result;
			if (databasePath) {
				// If we have a path, save directly to it
				result = await window.electron?.saveToFile(databasePath, new Uint8Array(arrayBuffer));
				if (!result?.success) {
					// If direct save fails, fall back to save dialog
					result = await window.electron?.saveFile(new Uint8Array(arrayBuffer));
					if (result?.success && result.filePath) {
						setDatabasePath(result.filePath);
					}
				}
			} else {
				// If no path, use save dialog
				result = await window.electron?.saveFile(new Uint8Array(arrayBuffer));
				if (result?.success && result.filePath) {
					setDatabasePath(result.filePath);
				}
			}

			if (!result?.success) {
				throw new Error(result?.error || 'Failed to save database');
			}
		} catch (err) {
			console.error('Failed to save database:', err);
			setError('Failed to save database changes');
		}
	};

	if (database) {
		return (
			<>
				<TitleBar
					inPasswordView={true}
					onLock={handleLock}
					searchQuery={searchQuery}
					onSearch={setSearchQuery}
				/>
				<PasswordView
					database={database}
					searchQuery={searchQuery}
					onDatabaseChange={handleDatabaseChange}
				/>
			</>
		);
	}

	return (
		<>
			<TitleBar inPasswordView={false} />
			<div
				className="app"
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				<Background />

				<div className={`drop-overlay ${isDragging ? 'visible' : ''}`}>
					<div className="drop-message">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							className="upload-icon"
						>
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
							<polyline points="17 8 12 3 7 8" />
							<line x1="12" y1="3" x2="12" y2="15" />
						</svg>
						Drop your KeePass database here
					</div>
				</div>

				<main className="main-content">
					<div className="database-form">
						<div className="form-icon">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								className="lock-icon"
							>
								<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
								<path d="M7 11V7a5 5 0 0 1 10 0v4" />
							</svg>
						</div>
						<h1>{isCreatingNew ? 'Create Database' : 'Open Database'}</h1>

						{!selectedFile && !isCreatingNew ? (
							<>
								<p>Select or drop your KeePass database file to get started</p>
								<div className="database-actions">
									<label className="file-input-label">
										<svg
											xmlns="http://www.w3.org/2000/svg"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											className="browse-icon"
										>
											<path d="M20 11.08V8l-6-6H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2v-3.08" />
											<path d="M14 3v5h5M18 21v-6M15 18h6" />
										</svg>
										Browse Database
										<input
											type="file"
											accept=".kdbx"
											onChange={handleFileSelect}
											className="file-input"
										/>
									</label>
									<button
										className="create-new-button"
										onClick={() => setIsCreatingNew(true)}
									>
										Create New Database
									</button>
								</div>
							</>
						) : (
							<div className="password-form">
								{selectedFile && (
									<div className="selected-file">
										<span>{selectedFile.name}</span>
										<button
											className="clear-file"
											onClick={() => {
												setSelectedFile(null)
												setError(null)
											}}
											title="Clear selection"
										>
											×
										</button>
									</div>
								)}
								{isCreatingNew && (
									<div className="input-container">
										<input
											type="text"
											placeholder="Database name"
											className="text-input"
											value={databaseName}
											onChange={(e) => setDatabaseName(e.target.value)}
											onKeyPress={handleKeyPress}
										/>
									</div>
								)}
								<div className="password-input-container">
									<input
										type={showPassword ? 'text' : 'password'}
										placeholder="Enter password"
										className="password-input"
										value={password}
										onChange={(e) => setPassword(e.target.value)}
										ref={passwordInputRef}
										onKeyPress={handleKeyPress}
									/>
									<button
										className="toggle-password"
										onClick={() => setShowPassword(!showPassword)}
										type="button"
										title={showPassword ? 'Hide password' : 'Show password'}
									>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
										>
											{showPassword ? (
												<>
													<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
													<line x1="1" y1="1" x2="23" y2="23" />
												</>
											) : (
												<>
													<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
													<circle cx="12" cy="12" r="3" />
												</>
											)}
										</svg>
									</button>
								</div>

								{isCreatingNew && (
									<div className="password-input-container">
										<input
											type={showPassword ? 'text' : 'password'}
											placeholder="Confirm password"
											className="password-input"
											value={confirmPassword}
											onChange={(e) => setConfirmPassword(e.target.value)}
											onKeyPress={handleKeyPress}
										/>
									</div>
								)}

								{error && <div className="error-message">{error}</div>}

								<div className="form-buttons">
									<button
										className="cancel-button"
										onClick={() => {
											setIsCreatingNew(false)
											setSelectedFile(null)
											setPassword('')
											setConfirmPassword('')
											setDatabaseName('New Database')
											setError(null)
										}}
									>
										Cancel
									</button>
									<button
										className={`unlock-button ${isLoading ? 'loading' : ''}`}
										onClick={isCreatingNew ? handleCreateNew : handleUnlock}
										disabled={isLoading}
									>
										{isLoading ? (
											<svg
												className="spinner"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
											>
												<circle className="spinner-circle" cx="12" cy="12" r="10" />
											</svg>
										) : (
											<>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
													className="unlock-icon"
												>
													<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
													<path d="M7 11V7a5 5 0 0 1 9.9-1" />
												</svg>
												Unlock Database
											</>
										)}
									</button>
								</div>
							</div>
						)}
					</div>
				</main>
			</div>
		</>
	)
}

export default App
