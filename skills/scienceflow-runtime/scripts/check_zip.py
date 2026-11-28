import zipfile
with zipfile.ZipFile('assets/repo.zip') as z:
    names = z.namelist()
    print('Total entries:', len(names))
    tomls = [n for n in names if n.endswith('pyproject.toml')]
    print('pyproject.toml files:', tomls)
    for t in tomls:
        print('---', t, '---')
        print(z.read(t).decode('utf-8')[:2000])
